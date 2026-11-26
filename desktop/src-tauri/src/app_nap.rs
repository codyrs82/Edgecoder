// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

//! Keep macOS from napping the app while it hosts (network run 12).
//!
//! The app is usually in the background or has no window open while its agent serves the
//! network. macOS then puts it in App Nap: its timers are coalesced and stretched and it runs at
//! background priority, and the agent it spawned (its own child process) can be slowed with it. In run 12 the owner's
//! Mac pulled the coordinator 0.9 to 21 s apart while idle (the Fly agents about every 3 s) and
//! calls placed on it were not claimed within the decision window.
//!
//! The documented way out is to declare the activity: `-[NSProcessInfo
//! beginActivityWithOptions:reason:]` with `NSActivityUserInitiatedAllowingIdleSystemSleep`,
//! held for the app's lifetime. That turns App Nap and timer coalescing off for the app, but
//! still lets the Mac sleep when idle (it never keeps a laptop awake) and lets the display sleep.
//!
//! Called through the Objective-C runtime directly (libobjc and Foundation, which every macOS app
//! links), so no new crate is needed. Elsewhere it does nothing.

/// `NSActivityIdleSystemSleepDisabled` (NSProcessInfo.h).
pub const NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED: u64 = 1 << 20;
/// `NSActivityUserInitiated`: `0x00FFFFFF | NSActivityIdleSystemSleepDisabled`.
pub const NS_ACTIVITY_USER_INITIATED: u64 = 0x00FF_FFFF | NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED;
/// `NSActivityUserInitiatedAllowingIdleSystemSleep`: no App Nap, but idle system sleep allowed.
pub const NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 =
    NS_ACTIVITY_USER_INITIATED & !NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED;

pub const REASON: &str = "EdgeCoder hosts models for your account and the network: it must answer work offers promptly while in the background";

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::{c_char, c_void, CString};
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }
    // NSProcessInfo and NSString live in Foundation.
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    /// The activity object, retained and never released: the activity lasts as long as the app.
    static ACTIVITY: AtomicUsize = AtomicUsize::new(0);

    fn sel(name: &str) -> Sel {
        let c = CString::new(name).expect("selector name");
        unsafe { sel_registerName(c.as_ptr()) }
    }

    pub fn begin(options: u64, reason: &str) -> bool {
        if ACTIVITY.load(Ordering::SeqCst) != 0 {
            return true;
        }
        let Ok(class_name) = CString::new("NSProcessInfo") else { return false };
        let Ok(string_class) = CString::new("NSString") else { return false };
        let Ok(reason_c) = CString::new(reason) else { return false };
        unsafe {
            // objc_msgSend must be called through a pointer of the method's exact type (arm64).
            let send0: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let send_cstr: unsafe extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let send_begin: unsafe extern "C" fn(Id, Sel, u64, Id) -> Id = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());

            let pool = objc_autoreleasePoolPush();
            let process_info_class = objc_getClass(class_name.as_ptr());
            let ns_string_class = objc_getClass(string_class.as_ptr());
            let mut ok = false;
            if !process_info_class.is_null() && !ns_string_class.is_null() {
                let process_info = send0(process_info_class, sel("processInfo"));
                let ns_reason = send_cstr(ns_string_class, sel("stringWithUTF8String:"), reason_c.as_ptr());
                if !process_info.is_null() && !ns_reason.is_null() {
                    let activity = send_begin(process_info, sel("beginActivityWithOptions:reason:"), options, ns_reason);
                    if !activity.is_null() {
                        // Autoreleased: keep our own reference past the pool.
                        send0(activity, sel("retain"));
                        ACTIVITY.store(activity as usize, Ordering::SeqCst);
                        ok = true;
                    }
                }
            }
            objc_autoreleasePoolPop(pool);
            ok
        }
    }
}

/// Declare the hosting activity for the rest of the app's life (macOS); true when it is held.
/// Calling it again does nothing. Elsewhere it returns false.
pub fn keep_app_awake_for_hosting() -> bool {
    #[cfg(target_os = "macos")]
    {
        imp::begin(NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP, REASON)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_turn_off_app_nap_but_allow_idle_system_sleep() {
        // The SDK's value of NSActivityUserInitiatedAllowingIdleSystemSleep.
        assert_eq!(NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP, 0x00EF_FFFF);
        assert_eq!(NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP & NS_ACTIVITY_IDLE_SYSTEM_SLEEP_DISABLED, 0);
        // Not the display-sleep or latency-critical bits: the screen still sleeps.
        assert_eq!(NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP & (1 << 40), 0);
        assert_eq!(NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP & 0xFF_0000_0000, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn begins_the_activity_once() {
        assert!(keep_app_awake_for_hosting());
        assert!(keep_app_awake_for_hosting());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn does_nothing_elsewhere() {
        assert!(!keep_app_awake_for_hosting());
    }
}
