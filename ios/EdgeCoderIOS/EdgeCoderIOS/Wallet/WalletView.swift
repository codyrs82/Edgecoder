import Security
import SwiftUI

struct WalletView: View {
    @State private var onboarding: WalletOnboardingStatus?
    @State private var errorText = ""
    @State private var loading = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Onboarding") {
                    if let onboarding {
                        LabeledContent("Account", value: onboarding.accountId)
                        LabeledContent("Network", value: onboarding.network)
                        LabeledContent(
                            "Backup acknowledged",
                            value: onboarding.acknowledgedAtMs != nil ? "yes" : "no"
                        )
                    } else if loading {
                        ProgressView("Loading wallet state...")
                    } else {
                        Text("No onboarding state available.")
                    }
                }

                Section("Actions") {
                    Button("Acknowledge Seed Backup") {
                        Task { await acknowledge() }
                    }
                    .disabled(loading)

                    Button("Store Sample Secret in Keychain") {
                        KeychainHelper.shared.store(value: "seed-backup-ack", key: "edgecoder.wallet.ack")
                    }
                    .disabled(loading)
                }

                if !errorText.isEmpty {
                    Section("Error") {
                        Text(errorText)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Wallet")
            .toolbar {
                Button("Refresh") {
                    Task { await load() }
                }
            }
            .task {
                await load()
            }
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
            errorText = ""
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func acknowledge() async {
        loading = true
        defer { loading = false }
        do {
            _ = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/wallet/onboarding/acknowledge",
                method: "POST",
                body: [String: Bool]()
            ) as EmptyResponse
            await load()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

final class KeychainHelper {
    static let shared = KeychainHelper()

    func store(value: String, key: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: data
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
}
