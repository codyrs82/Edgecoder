//! Keeps the app's webview on the app. Chat messages carry model output, so a link, form or
//! redirect in one must not replace the app with a remote page (a fake sign-in screen in a window
//! with no URL bar). Links in chat open in the system browser from the frontend; here every
//! navigation to anywhere else is refused.
//!
//! The hook sees frame navigations too, so the IDE preview iframe's origin is allowed.

use tauri::{plugin::TauriPlugin, Runtime, Url};

/// Origin of the IDE preview server, loaded in an iframe (CSP frame-src).
const PREVIEW_HOST: &str = "127.0.0.1";
const PREVIEW_PORT: u16 = 4306;

/// True when the webview may navigate to `url`: the bundled app, the preview iframe, about:blank
/// and about:srcdoc, and in debug builds the Vite dev server.
pub fn is_allowed(url: &Url) -> bool {
    match url.scheme() {
        // macOS and Linux serve the app from tauri://localhost.
        "tauri" => url.host_str() == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => {
            let host = url.host_str();
            // Windows serves the app from http(s)://tauri.localhost.
            if host == Some("tauri.localhost") {
                return true;
            }
            if url.scheme() == "http" && host == Some(PREVIEW_HOST) && url.port() == Some(PREVIEW_PORT) {
                return true;
            }
            cfg!(debug_assertions) && url.scheme() == "http" && host == Some("localhost") && url.port() == Some(1420)
        }
        _ => false,
    }
}

/// Plugin that refuses navigations `is_allowed` rejects, in every webview of the app.
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let ok = is_allowed(url);
            if !ok {
                eprintln!("[navigation] blocked navigation to {}://{}", url.scheme(), url.host_str().unwrap_or(""));
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::is_allowed;
    use tauri::Url;

    fn ok(s: &str) -> bool {
        is_allowed(&Url::parse(s).unwrap())
    }

    #[test]
    fn allows_the_app_and_the_preview_iframe() {
        assert!(ok("tauri://localhost/"));
        assert!(ok("tauri://localhost/index.html#/chat"));
        assert!(ok("http://tauri.localhost/"));
        assert!(ok("https://tauri.localhost/"));
        assert!(ok("http://127.0.0.1:4306/project/index.html"));
        assert!(ok("about:blank"));
        assert!(ok("about:srcdoc"));
    }

    #[test]
    fn refuses_everything_else() {
        for s in [
            "https://attacker.example/login",
            "http://attacker.example/",
            "https://edgecoder.io/portal",
            "tauri://attacker.example/",
            "https://tauri.localhost.attacker.example/",
            "http://127.0.0.1:4304/",
            "https://127.0.0.1:4306/",
            "http://localhost:4306/",
            "file:///etc/passwd",
            "data:text/html,<h1>x</h1>",
            "javascript:alert(1)",
            "about:config",
        ] {
            assert!(!ok(s), "{s} should be refused");
        }
    }
}
