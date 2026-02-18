import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    private let config = AppConfig.current

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Node ID", text: $swarmRuntime.agentId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("Unique identifier for this device in the network. Also editable in the Swarm tab.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Reset to device-based ID") {
                        swarmRuntime.agentId = SwarmRuntimeController.defaultIosAgentId()
                        swarmRuntime.persistRuntimeSettings()
                    }
                } header: {
                    Text("Node identity")
                } footer: {
                    Text("Based on your device name (Settings > General > About) plus a random suffix. Change it to something memorable (e.g. office-iphone).")
                }

                Section("Environment") {
                    LabeledContent("Mode", value: config.environment.rawValue)
                    LabeledContent("Portal", value: config.portalBaseURL.absoluteString)
                    LabeledContent("Control plane", value: config.controlPlaneBaseURL.absoluteString)
                    LabeledContent("Coordinator bootstrap", value: config.coordinatorBootstrapURL.absoluteString)
                }

                Section("Passkeys") {
                    LabeledContent("RP ID", value: config.relyingPartyId)
                    LabeledContent("Origin", value: config.passkeyOrigin)
                }

                Section("Release Notes") {
                    Text("This build includes native auth, passkeys, wallet onboarding, dashboard stats, and swarm runtime controls.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
        }
    }
}
