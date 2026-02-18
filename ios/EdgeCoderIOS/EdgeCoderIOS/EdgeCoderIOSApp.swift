import SwiftUI

@main
struct EdgeCoderIOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var swarmRuntime = SwarmRuntimeController.shared

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(sessionStore)
                .environmentObject(swarmRuntime)
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIApplication.didEnterBackgroundNotification
                    )
                ) { _ in
                    // Schedule background tasks whenever the app backgrounds
                    // so iOS can wake us to keep heartbeating.
                    if swarmRuntime.computeMode != .off {
                        AppDelegate.scheduleBackgroundTasksIfNeeded()
                    }
                }
        }
    }
}
