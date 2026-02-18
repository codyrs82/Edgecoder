import SwiftUI

@main
struct EdgeCoderIOSApp: App {
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var swarmRuntime = SwarmRuntimeController.shared

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(sessionStore)
                .environmentObject(swarmRuntime)
        }
    }
}
