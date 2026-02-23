import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @State private var selectedTab: AppTab = .dashboard

    var body: some View {
        TabView(selection: $selectedTab) {
            DashboardView()
                .tag(AppTab.dashboard)
                .tabItem {
                    Label("Dashboard", systemImage: "chart.bar")
                }

            WalletView()
                .tag(AppTab.wallet)
                .tabItem {
                    Label("Wallet", systemImage: "bitcoinsign.circle")
                }

            SwarmView()
                .tag(AppTab.swarm)
                .tabItem {
                    Label("Swarm", systemImage: "network")
                }

            AuthView()
                .tag(AppTab.auth)
                .tabItem {
                    Label(sessionStore.isAuthenticated ? "Account" : "Auth", systemImage: "person")
                }

            SettingsView()
                .tag(AppTab.settings)
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        .task {
            if !sessionStore.isAuthenticated {
                await sessionStore.refreshSession()
            }
            if !sessionStore.isAuthenticated {
                selectedTab = .auth
            } else {
                await swarmRuntime.ensureEnrollment()
                await swarmRuntime.autoStartIfReady()
            }
        }
        .onChange(of: sessionStore.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated {
                Task {
                    await swarmRuntime.ensureEnrollment()
                    await swarmRuntime.autoStartIfReady()
                }
            }
        }
    }
}

private enum AppTab {
    case dashboard
    case wallet
    case swarm
    case auth
    case settings
}
