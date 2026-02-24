import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @EnvironmentObject private var conversationStore: ConversationStore
    @EnvironmentObject private var chatRouter: ChatRouter
    @StateObject private var bt = BluetoothTransport.shared
    @State private var selectedTab: AppTab = .chat
    @State private var showLoginSheet = false

    var body: some View {
        TabView(selection: $selectedTab) {
            ChatView()
                .tag(AppTab.chat)
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }

            IDEView()
                .tag(AppTab.edgecoder)
                .tabItem {
                    Label("EdgeCoder", systemImage: "laptopcomputer.and.iphone")
                }
                .badge(runningTaskCount > 0 ? runningTaskCount : 0)
        }
        .tint(Theme.accent)
        .task {
            if swarmRuntime.isLocalCoordinator {
                await swarmRuntime.autoStartIfReady()
            } else {
                if !sessionStore.isAuthenticated {
                    await sessionStore.refreshSession()
                }
                if !sessionStore.isAuthenticated {
                    showLoginSheet = true
                } else {
                    await swarmRuntime.ensureEnrollment()
                    await swarmRuntime.autoStartIfReady()
                }
            }
        }
        .onChange(of: sessionStore.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated {
                showLoginSheet = false
                Task {
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

    private var runningTaskCount: Int {
        bt.ideTasks.filter { $0.status == .running }.count
    }
}

private enum AppTab {
    case chat
    case edgecoder
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
                    Text("Sign in to access swarm network, wallet, and stats.")
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

                    Button("Create Account") {
                        Task {
                            await viewModel.signUp(sessionStore: sessionStore)
                            if sessionStore.isAuthenticated { dismiss() }
                        }
                    }
                    .disabled(viewModel.email.isEmpty || viewModel.password.count < 8 || viewModel.isLoading)
                }

                if !viewModel.statusMessage.isEmpty {
                    Section {
                        Text(viewModel.statusMessage)
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                    }
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
