import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @Environment(\.dismiss) private var dismiss

    @StateObject private var authViewModel = AuthViewModel()
    @ObservedObject private var swarmRuntime = SwarmRuntimeController.shared
    private let config = AppConfig.current

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    accountCard
                    runtimeCard
                    modelCard
                    networkCard
                    nodeCard
                    aboutCard
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(Theme.bgDeep)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgBase, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundColor(Theme.accent)
                }
            }
            .task {
                if !sessionStore.isAuthenticated {
                    await sessionStore.refreshSession()
                }
                await authViewModel.refreshAuthCapabilities()
            }
        }
    }

    // MARK: - Account Card

    private var accountCard: some View {
        SettingsCard {
            if sessionStore.isAuthenticated {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(Theme.accent.opacity(0.2))
                            .frame(width: 44, height: 44)
                        Text(String((sessionStore.user?.email ?? "U").prefix(1)).uppercased())
                            .font(.headline.weight(.semibold))
                            .foregroundColor(Theme.accent)
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        Text(sessionStore.user?.email ?? "Account")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(Theme.textPrimary)
                        HStack(spacing: 5) {
                            Circle().fill(Theme.green).frame(width: 6, height: 6)
                            Text("Signed in")
                                .font(.caption)
                                .foregroundColor(Theme.textMuted)
                        }
                    }
                    Spacer()
                    Button("Sign Out") {
                        Task { await authViewModel.logout(sessionStore: sessionStore) }
                    }
                    .font(.caption.weight(.medium))
                    .foregroundColor(Theme.red)
                }
            } else {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(Theme.bgElevated)
                            .frame(width: 44, height: 44)
                        Image(systemName: "person.fill")
                            .foregroundColor(Theme.textMuted)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Not signed in")
                            .font(.subheadline.weight(.medium))
                            .foregroundColor(Theme.textPrimary)
                        Text("Sign in for network & wallet")
                            .font(.caption)
                            .foregroundColor(Theme.textMuted)
                    }
                    Spacer()
                }

                Divider().overlay(Theme.border)

                Button {
                    Task { await authViewModel.loginWithPasskey(sessionStore: sessionStore) }
                } label: {
                    HStack {
                        Image(systemName: "faceid")
                        Text("Sign in with Passkey")
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundColor(Theme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Theme.bgElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(authViewModel.isLoading)

                VStack(spacing: 10) {
                    TextField("Email", text: $authViewModel.email)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .font(.subheadline)
                        .foregroundColor(Theme.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Theme.bgInput)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    SecureField("Password", text: $authViewModel.password)
                        .font(.subheadline)
                        .foregroundColor(Theme.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Theme.bgInput)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    HStack(spacing: 10) {
                        Button {
                            Task { await authViewModel.login(sessionStore: sessionStore) }
                        } label: {
                            Text("Log In")
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(Theme.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .disabled(authViewModel.email.isEmpty || authViewModel.password.isEmpty || authViewModel.isLoading)

                        Button {
                            Task { await authViewModel.signUp(sessionStore: sessionStore) }
                        } label: {
                            Text("Create Account")
                                .font(.subheadline.weight(.medium))
                                .foregroundColor(Theme.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Theme.bgElevated)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .disabled(authViewModel.email.isEmpty || authViewModel.password.count < 8 || authViewModel.isLoading)
                    }
                }

                if !authViewModel.statusMessage.isEmpty {
                    Text(authViewModel.statusMessage)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                }
            }
        }
    }

    // MARK: - Runtime Card

    private var runtimeCard: some View {
        SettingsCard {
            SettingsCardHeader(icon: "bolt.fill", title: "Runtime", color: Theme.green)

            HStack(spacing: 8) {
                StatusPill(label: swarmRuntime.state.rawValue.capitalized, color: stateColor)
                Spacer()
                runtimeButtons
            }

            Divider().overlay(Theme.border)

            HStack(spacing: 0) {
                StatCell(label: "Tasks", value: "\(swarmRuntime.tasksCompleted)")
                StatCell(label: "Failed", value: "\(swarmRuntime.tasksFailed)")
                StatCell(label: "Credits", value: "\(swarmRuntime.creditsEarned)")
                StatCell(label: "Beats", value: "\(swarmRuntime.heartbeatCount)")
            }

            Divider().overlay(Theme.border)

            SettingsToggle(title: "Auto-start on launch", isOn: $swarmRuntime.autoStartEnabled) {
                swarmRuntime.persistRuntimeSettings()
            }
            SettingsToggle(title: "Run only when charging", isOn: $swarmRuntime.runOnlyWhileCharging) {
                swarmRuntime.persistRuntimeSettings()
            }
        }
    }

    private var stateColor: Color {
        switch swarmRuntime.state {
        case .running: return Theme.green
        case .paused: return Theme.yellow
        case .stopped: return Theme.textMuted
        default: return Theme.textMuted
        }
    }

    private var runtimeButtons: some View {
        HStack(spacing: 8) {
            if swarmRuntime.state != .running {
                Button { Task { await swarmRuntime.start() } } label: {
                    Image(systemName: "play.fill")
                        .font(.caption)
                        .foregroundColor(Theme.bgDeep)
                        .padding(8)
                        .background(Theme.green)
                        .clipShape(Circle())
                }
            }
            if swarmRuntime.state == .running {
                Button { swarmRuntime.pause() } label: {
                    Image(systemName: "pause.fill")
                        .font(.caption)
                        .foregroundColor(Theme.textPrimary)
                        .padding(8)
                        .background(Theme.bgElevated)
                        .clipShape(Circle())
                }
            }
            if swarmRuntime.state != .stopped {
                Button { swarmRuntime.stop() } label: {
                    Image(systemName: "stop.fill")
                        .font(.caption)
                        .foregroundColor(Theme.red)
                        .padding(8)
                        .background(Theme.bgElevated)
                        .clipShape(Circle())
                }
            }
        }
    }

    // MARK: - Model Card

    private var modelCard: some View {
        SettingsCard {
            SettingsCardHeader(icon: "cpu", title: "Local Model", color: Theme.accentSecondary)
            ModelPickerView(modelManager: swarmRuntime.modelManager)
            ModelStatusBanner(modelManager: swarmRuntime.modelManager)
        }
    }

    // MARK: - Network Card

    private var networkCard: some View {
        SettingsCard {
            SettingsCardHeader(icon: "antenna.radiowaves.left.and.right", title: "Network", color: Theme.accent)

            HStack(spacing: 0) {
                StatCell(label: "Peers", value: "\(swarmRuntime.bleMeshManager.discoveredPeers.count)")
                StatCell(label: "Battery", value: "\(swarmRuntime.batteryPct)%")
                StatCell(label: "Power", value: swarmRuntime.isOnExternalPower ? "AC" : "Bat")
            }

            if !swarmRuntime.discoveredCoordinators.isEmpty {
                Divider().overlay(Theme.border)
                ForEach(swarmRuntime.discoveredCoordinators, id: \.self) { coordinator in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(coordinator.coordinatorUrl)
                                .font(.caption.monospaced())
                                .foregroundColor(Theme.textSecondary)
                            Text(coordinator.source)
                                .font(.caption2)
                                .foregroundColor(Theme.textMuted)
                        }
                        Spacer()
                    }
                }
            }

            Button {
                Task { await swarmRuntime.discoverCoordinators() }
            } label: {
                Text("Discover Coordinators")
                    .font(.caption.weight(.medium))
                    .foregroundColor(Theme.accent)
            }

            WalletSummaryRow()
        }
    }

    // MARK: - Node Card

    private var nodeCard: some View {
        SettingsCard {
            SettingsCardHeader(icon: "server.rack", title: "Node Identity", color: Theme.textSecondary)

            VStack(spacing: 10) {
                SettingsTextField(label: "Node ID", text: $swarmRuntime.agentId)
                SettingsTextField(label: "Coordinator", text: $swarmRuntime.selectedCoordinatorURL)
            }

            HStack {
                SettingsLabel(
                    label: "Registration",
                    value: swarmRuntime.registrationToken.isEmpty ? "Not enrolled" : "Enrolled"
                )
                Spacer()
                Button("Reset ID") {
                    swarmRuntime.agentId = SwarmRuntimeController.defaultIosAgentId()
                    swarmRuntime.persistRuntimeSettings()
                }
                .font(.caption.weight(.medium))
                .foregroundColor(Theme.accent)
            }
        }
    }

    // MARK: - About Card

    private var aboutCard: some View {
        SettingsCard {
            SettingsCardHeader(icon: "info.circle", title: "About", color: Theme.textMuted)

            SettingsLabel(label: "Environment", value: config.environment.rawValue)
            SettingsLabel(label: "Portal", value: config.portalBaseURL.host ?? config.portalBaseURL.absoluteString)

            SettingsToggle(title: "Upload diagnostics", isOn: $swarmRuntime.diagnosticsUploadEnabled) {
                swarmRuntime.persistRuntimeSettings()
            }

            if !swarmRuntime.runtimeEvents.isEmpty {
                Divider().overlay(Theme.border)
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(swarmRuntime.runtimeEvents.prefix(10).enumerated()), id: \.offset) { _, event in
                            Text(event)
                                .font(.caption2.monospaced())
                                .foregroundColor(Theme.textMuted)
                        }
                    }
                } label: {
                    Text("Runtime Events")
                        .font(.caption.weight(.medium))
                        .foregroundColor(Theme.textSecondary)
                }
                .tint(Theme.textMuted)
            }
        }
    }
}

// MARK: - Reusable Components

private struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct SettingsCardHeader: View {
    let icon: String
    let title: String
    var color: Color = Theme.textSecondary

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundColor(color)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(Theme.textPrimary)
        }
    }
}

private struct StatusPill: View {
    let label: String
    var color: Color = Theme.textMuted

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundColor(Theme.textPrimary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(color.opacity(0.15))
        .clipShape(Capsule())
    }
}

private struct StatCell: View {
    let label: String
    let value: String

    var body: some View {
        VStack(spacing: 3) {
            Text(value)
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundColor(Theme.textPrimary)
            Text(label)
                .font(.caption2)
                .foregroundColor(Theme.textMuted)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct SettingsToggle: View {
    let title: String
    @Binding var isOn: Bool
    var onChange: (() -> Void)?

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title)
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
        }
        .tint(Theme.accent)
        .onChange(of: isOn) { _, _ in onChange?() }
    }
}

private struct SettingsTextField: View {
    let label: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundColor(Theme.textMuted)
            TextField(label, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.caption.monospaced())
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Theme.bgInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
}

private struct SettingsLabel: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundColor(Theme.textSecondary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundColor(Theme.textMuted)
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
                HStack {
                    ProgressView()
                        .tint(Theme.textMuted)
                    Text("Loading wallet...")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                }
            } else if let onboarding {
                Divider().overlay(Theme.border)
                SettingsCardHeader(icon: "bitcoinsign.circle", title: "Wallet", color: Theme.yellow)
                SettingsLabel(label: "Account", value: String(onboarding.accountId.prefix(12)) + "...")
                SettingsLabel(label: "Network", value: onboarding.network)
            } else {
                // No wallet — don't show anything
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
