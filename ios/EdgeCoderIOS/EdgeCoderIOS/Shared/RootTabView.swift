import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @EnvironmentObject private var conversationStore: ConversationStore
    @EnvironmentObject private var chatRouter: ChatRouter
    @EnvironmentObject private var purchasePolicy: PurchasePolicy
    @EnvironmentObject private var networkStatus: NetworkStatusStore
    @State private var selectedTab: AppTab = .chat
    @State private var showLoginSheet = false

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatView()
                .tag(AppTab.chat)
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }

            BotsView()
                .tag(AppTab.bots)
                .tabItem {
                    Label("Bots", systemImage: "person.2.wave.2")
                }

            NavigationStack {
                WalletView()
            }
                .tag(AppTab.wallet)
                .tabItem {
                    Label("Wallet", systemImage: "wallet.pass")
                }

            MachinesView()
                .tag(AppTab.machines)
                .tabItem {
                    Label("Machines", systemImage: "server.rack")
                }
        }
        .tint(Theme.accent)
        .task {
            await purchasePolicy.refreshStorefront()
            if swarmRuntime.isLocalCoordinator {
                await swarmRuntime.autoStartIfReady()
            } else {
                if !sessionStore.isAuthenticated {
                    await sessionStore.refreshSession()
                }
                if !sessionStore.isAuthenticated {
                    showLoginSheet = true
                } else {
                    await networkStatus.refresh()
                    await swarmRuntime.ensureEnrollment()
                    await swarmRuntime.autoStartIfReady()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .edgeCoderBalanceChanged)) { _ in
            Task { await networkStatus.refresh() }
        }
        .onChange(of: sessionStore.isAuthenticated) { _, isAuthenticated in
            if !isAuthenticated { networkStatus.clear() }
            if isAuthenticated {
                showLoginSheet = false
                Task {
                    await networkStatus.refresh()
                    await swarmRuntime.ensureEnrollment()
                    await swarmRuntime.autoStartIfReady()
                }
            }
        }
        .onChange(of: swarmRuntime.selectedCoordinatorURL) { _, _ in
            if swarmRuntime.isLocalCoordinator {
                Task {
                    await swarmRuntime.autoStartIfReady()
                }
            }
        }
        .sheet(isPresented: $showLoginSheet) {
            LoginSheet()
                .environmentObject(sessionStore)
        }
    }
}

private enum AppTab {
    case chat
    case bots
    case wallet
    case machines
}

// MARK: - Login Sheet (replaces Auth tab)

private struct LoginSheet: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @StateObject private var viewModel = AuthViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Sign in to chat on your machines and the EdgeCoder network, and to see your bots and wallet.")
                        .font(.subheadline)
                        .foregroundColor(Theme.textSecondary)
                }

                Section("Passkey") {
                    Button {
                        Task {
                            await viewModel.loginWithPasskey(sessionStore: sessionStore)
                            if sessionStore.isAuthenticated { dismiss() }
                        }
                    } label: {
                        Label("Sign in with Passkey", systemImage: "faceid")
                    }
                    .disabled(viewModel.isLoading)
                    if viewModel.isLoading {
                        ProgressView()
                    }
                }

                // Shown right under the buttons so a failed sign-in is never silent.
                if !viewModel.statusMessage.isEmpty {
                    Section {
                        Text(viewModel.statusMessage)
                            .font(.footnote)
                            .foregroundColor(Theme.textPrimary)
                            .accessibilityIdentifier("signInStatus")
                    }
                }

                Section("Credentials") {
                    TextField("Email", text: $viewModel.email)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    SecureField("Password", text: $viewModel.password)

                    Button("Log In") {
                        Task {
                            await viewModel.login(sessionStore: sessionStore)
                            if sessionStore.isAuthenticated { dismiss() }
                        }
                    }
                    .disabled(viewModel.email.isEmpty || viewModel.password.isEmpty || viewModel.isLoading)

                }

                // No account creation in the iOS app until the portal has in-app account deletion
                // (App Store Review Guideline 5.1.1(v)); see docs/ios-app-store-release.md.
                Section {
                    Text("New to EdgeCoder? Create your account on edgecoder.io, then sign in here.")
                        .font(.footnote)
                        .foregroundColor(Theme.textSecondary)
                }

            }
            .navigationTitle("Sign In")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Skip") { dismiss() }
                }
            }
        }
    }
}
