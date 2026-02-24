import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @Environment(\.dismiss) private var dismiss

    @StateObject private var authViewModel = AuthViewModel()
    @ObservedObject private var swarmRuntime = SwarmRuntimeController.shared
    private let config = AppConfig.current

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                nodeSection
                modelSection
                swarmSection
                walletSection
                networkSection
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bgBase)
            .task {
                if !sessionStore.isAuthenticated {
                    await sessionStore.refreshSession()
                }
                await authViewModel.refreshAuthCapabilities()
            }
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
            if sessionStore.isAuthenticated {
                HStack(spacing: 12) {
                    Image(systemName: "person.circle.fill")
                        .font(.title)
                        .foregroundColor(Theme.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sessionStore.user?.email ?? "Account")
                            .font(.subheadline.weight(.medium))
                        HStack(spacing: 4) {
                            Circle()
                                .fill(Theme.green)
                                .frame(width: 6, height: 6)
                            Text("Signed in")
                                .font(.caption)
                                .foregroundColor(Theme.textMuted)
                        }
                    }
                }

                Button("Log Out", role: .destructive) {
                    Task { await authViewModel.logout(sessionStore: sessionStore) }
                }
            } else {
                HStack(spacing: 12) {
                    Image(systemName: "person.circle")
                        .font(.title)
                        .foregroundColor(Theme.textMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Not signed in")
                            .font(.subheadline.weight(.medium))
                        Text("Sign in for network stats and wallet")
                            .font(.caption)
                            .foregroundColor(Theme.textMuted)
                    }
                }

                // Passkey login
                Button {
                    Task { await authViewModel.loginWithPasskey(sessionStore: sessionStore) }
                } label: {
                    Label("Sign in with Passkey", systemImage: "faceid")
                }
                .disabled(authViewModel.isLoading)

                // Email/password
                TextField("Email", text: $authViewModel.email)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                SecureField("Password", text: $authViewModel.password)

                Button("Log In") {
                    Task { await authViewModel.login(sessionStore: sessionStore) }
                }
                .disabled(authViewModel.email.isEmpty || authViewModel.password.isEmpty || authViewModel.isLoading)

                Button("Create Account") {
                    Task { await authViewModel.signUp(sessionStore: sessionStore) }
                }
                .disabled(authViewModel.email.isEmpty || authViewModel.password.count < 8 || authViewModel.isLoading)
            }

            if !authViewModel.statusMessage.isEmpty {
                Text(authViewModel.statusMessage)
                    .font(.caption)
                    .foregroundColor(Theme.textSecondary)
            }
        } header: {
            Text("Account")
        }
    }

    // MARK: - Node Identity

    private var nodeSection: some View {
        Section {
            TextField("Node ID", text: $swarmRuntime.agentId)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Reset to device-based ID") {
                swarmRuntime.agentId = SwarmRuntimeController.defaultIosAgentId()
                swarmRuntime.persistRuntimeSettings()
            }
            .font(.caption)

            TextField("Coordinator URL", text: $swarmRuntime.selectedCoordinatorURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.caption)

            LabeledContent("Registration", value: swarmRuntime.registrationToken.isEmpty ? "Not enrolled" : "Enrolled")
        } header: {
            Text("Node Identity")
        } footer: {
            Text("Your device's identity on the EdgeCoder network.")
        }
    }

    // MARK: - Model

    private var modelSection: some View {
        Section {
            ModelPickerView(modelManager: swarmRuntime.modelManager)
            ModelStatusBanner(modelManager: swarmRuntime.modelManager)
        } header: {
            Text("Local Model")
        }
    }

    // MARK: - Swarm Runtime

    private var swarmSection: some View {
        Section {
            LabeledContent("State", value: swarmRuntime.state.rawValue.capitalized)

            HStack {
                Button("Start") { Task { await swarmRuntime.start() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(swarmRuntime.state == .running)
                Button("Pause") { swarmRuntime.pause() }
                    .buttonStyle(.bordered)
                    .disabled(swarmRuntime.state != .running)
                Button("Stop", role: .destructive) { swarmRuntime.stop() }
                    .buttonStyle(.bordered)
                    .disabled(swarmRuntime.state == .stopped)
            }

            Toggle("Auto-start on launch", isOn: $swarmRuntime.autoStartEnabled)
                .onChange(of: swarmRuntime.autoStartEnabled) { _, _ in
                    swarmRuntime.persistRuntimeSettings()
                }
            Toggle("Run only when charging", isOn: $swarmRuntime.runOnlyWhileCharging)
                .onChange(of: swarmRuntime.runOnlyWhileCharging) { _, _ in
                    swarmRuntime.persistRuntimeSettings()
                }

            LabeledContent("Heartbeats", value: String(swarmRuntime.heartbeatCount))
            LabeledContent("Tasks completed", value: String(swarmRuntime.tasksCompleted))
            LabeledContent("Tasks failed", value: String(swarmRuntime.tasksFailed))
            LabeledContent("Credits earned", value: String(swarmRuntime.creditsEarned))

            if let lastTask = swarmRuntime.lastTaskAt {
                LabeledContent("Last task", value: lastTask.formatted(date: .omitted, time: .standard))
            }
        } header: {
            Text("Swarm Runtime")
        }
    }

    // MARK: - Wallet

    private var walletSection: some View {
        Section {
            WalletSummaryRow()
        } header: {
            Text("Wallet")
        }
    }

    // MARK: - Network

    private var networkSection: some View {
        Section {
            let meshManager = swarmRuntime.bleMeshManager
            LabeledContent("BLE Peers", value: String(meshManager.discoveredPeers.count))
            LabeledContent("Battery", value: "\(swarmRuntime.batteryPct)%")
            LabeledContent("External Power", value: swarmRuntime.isOnExternalPower ? "Yes" : "No")
            LabeledContent("Low Power Mode", value: swarmRuntime.isLowPowerMode ? "On" : "Off")

            if !swarmRuntime.discoveredCoordinators.isEmpty {
                ForEach(swarmRuntime.discoveredCoordinators, id: \.self) { coordinator in
                    VStack(alignment: .leading) {
                        Text(coordinator.coordinatorUrl)
                            .font(.caption)
                        Text(coordinator.source)
                            .font(.caption2)
                            .foregroundColor(Theme.textMuted)
                    }
                }
            }

            Button("Discover Coordinators") {
                Task { await swarmRuntime.discoverCoordinators() }
            }
            .font(.caption)
        } header: {
            Text("Network")
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section {
            LabeledContent("Environment", value: config.environment.rawValue)
            LabeledContent("Portal", value: config.portalBaseURL.absoluteString)
                .font(.caption)

            Toggle("Upload diagnostics", isOn: $swarmRuntime.diagnosticsUploadEnabled)
                .onChange(of: swarmRuntime.diagnosticsUploadEnabled) { _, _ in
                    swarmRuntime.persistRuntimeSettings()
                }

            // Runtime events log
            if !swarmRuntime.runtimeEvents.isEmpty {
                DisclosureGroup("Runtime Events") {
                    ForEach(Array(swarmRuntime.runtimeEvents.prefix(10).enumerated()), id: \.offset) { _, event in
                        Text(event)
                            .font(.caption2.monospaced())
                            .foregroundColor(Theme.textMuted)
                    }
                }
            }
        } header: {
            Text("About")
        }
    }
}

// MARK: - Wallet Summary Row

private struct WalletSummaryRow: View {
    @State private var onboarding: WalletOnboardingStatus?
    @State private var loading = false

    var body: some View {
        Group {
            if loading {
                ProgressView("Loading wallet...")
            } else if let onboarding {
                LabeledContent("Account", value: onboarding.accountId)
                LabeledContent("Network", value: onboarding.network)
                LabeledContent("Backup", value: onboarding.acknowledgedAtMs != nil ? "Acknowledged" : "Pending")
            } else {
                Text("No wallet data. Sign in to view.")
                    .font(.caption)
                    .foregroundColor(Theme.textMuted)
            }
        }
        .task {
            await load()
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            onboarding = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/wallet/onboarding",
                method: "GET"
            )
        } catch {
            onboarding = nil
        }
    }
}
