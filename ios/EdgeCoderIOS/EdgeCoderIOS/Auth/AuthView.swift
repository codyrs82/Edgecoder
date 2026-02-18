import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @StateObject private var viewModel = AuthViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerCard
                    passkeyCard
                    ssoCard
                    credentialsCard
                    actionCard

                    if let seed = viewModel.latestSeedPhrase {
                        seedPhraseCard(seed: seed)
                    }

                    if !viewModel.latestGuidanceSteps.isEmpty {
                        guidanceCard
                    }

                    if !viewModel.statusMessage.isEmpty {
                        statusCard(viewModel.statusMessage)
                    }
                }
            }
            .padding(16)
            .navigationTitle(sessionStore.isAuthenticated ? "Account" : "Authentication")
            .background(Color(.systemGroupedBackground))
            .task {
                if !sessionStore.isAuthenticated {
                    await sessionStore.refreshSession()
                }
                await viewModel.refreshAuthCapabilities()
            }
        }
    }

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("EdgeCoder Access")
                .font(.title2.bold())
            Text("Secure sign-in for swarm controls, wallet actions, and node contribution stats.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Circle()
                    .fill(sessionStore.isAuthenticated ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(sessionStore.isAuthenticated ? "Signed in as \(sessionStore.user?.email ?? "account")" : "Not signed in")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if viewModel.isLoading {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .cardStyle()
    }

    private var passkeyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Passkeys")
                .font(.headline)
            Button {
                Task { await viewModel.loginWithPasskey(sessionStore: sessionStore) }
            } label: {
                labelRow(title: "Login with Passkey", systemImage: "faceid")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isLoading || !(viewModel.authCapabilities?.passkey.enabled ?? true))

            Button {
                Task { await viewModel.enrollPasskey() }
            } label: {
                labelRow(title: "Enroll Passkey", systemImage: "key.fill")
            }
            .buttonStyle(.bordered)
            .disabled(
                viewModel.isLoading ||
                !sessionStore.isAuthenticated ||
                !(viewModel.authCapabilities?.passkey.enabled ?? true)
            )

            Text("Passkey login can use your device credential directly. Enrollment requires an active session.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let capabilities = viewModel.authCapabilities {
                Text("RP ID: \(capabilities.passkey.rpId)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .cardStyle()
    }

    private var ssoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Single Sign-On")
                .font(.headline)
            ssoButton(title: "Continue with Google", provider: .google)
                .disabled(!(viewModel.authCapabilities?.oauth.google ?? true))
            ssoButton(title: "Continue with Microsoft 365", provider: .microsoft)
                .disabled(!(viewModel.authCapabilities?.oauth.microsoft ?? true))
            if let capabilities = viewModel.authCapabilities {
                if !capabilities.oauth.google || !capabilities.oauth.microsoft {
                    Text("Some SSO providers are not configured on the server.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .cardStyle()
    }

    private var credentialsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Credentials")
                .font(.headline)
            TextField("Email", text: $viewModel.email)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .textFieldStyle(.roundedBorder)
            SecureField("Password", text: $viewModel.password)
                .textFieldStyle(.roundedBorder)
            TextField("Display name (optional)", text: $viewModel.displayName)
                .textFieldStyle(.roundedBorder)
        }
        .cardStyle()
    }

    private var actionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Account Actions")
                .font(.headline)

            Button {
                Task { await viewModel.login(sessionStore: sessionStore) }
            } label: {
                labelRow(title: "Login", systemImage: "person.crop.circle.badge.checkmark")
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isLoading || viewModel.email.isEmpty || viewModel.password.isEmpty)

            Button {
                Task { await viewModel.signUp(sessionStore: sessionStore) }
            } label: {
                labelRow(title: "Create Account", systemImage: "person.badge.plus")
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.isLoading || viewModel.email.isEmpty || viewModel.password.count < 8)

            Button {
                Task { await viewModel.resendVerification() }
            } label: {
                labelRow(title: "Resend Verification", systemImage: "envelope.badge")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.blue)
            .disabled(viewModel.isLoading || viewModel.email.isEmpty)

            if sessionStore.isAuthenticated {
                Divider()
                Button(role: .destructive) {
                    Task { await viewModel.logout(sessionStore: sessionStore) }
                } label: {
                    labelRow(title: "Logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .cardStyle()
    }

    private func seedPhraseCard(seed: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Seed Phrase (Show Once)")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(seed)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.black.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text("Store offline only. This phrase grants full wallet recovery.")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Button("Clear from screen", role: .destructive) {
                viewModel.latestSeedPhrase = nil
            }
        }
        .cardStyle()
    }

    private var guidanceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Wallet Backup Guidance")
                .font(.headline)
            ForEach(viewModel.latestGuidanceSteps, id: \.self) { step in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text(step)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .cardStyle()
    }

    private func statusCard(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(.blue)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .cardStyle()
    }

    private func ssoButton(title: String, provider: SSOProvider) -> some View {
        Button {
            Task { await viewModel.loginWithSSO(provider: provider, sessionStore: sessionStore) }
        } label: {
            labelRow(title: title, systemImage: "arrow.up.right.square")
                .foregroundStyle(.blue)
                .padding(.vertical, 2)
        }
        .disabled(viewModel.isLoading)
    }

    private func labelRow(title: String, systemImage: String) -> some View {
        HStack {
            Image(systemName: systemImage)
            Text(title)
            Spacer()
        }
        .font(.subheadline.weight(.semibold))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension View {
    func cardStyle() -> some View {
        self
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
    }
}
