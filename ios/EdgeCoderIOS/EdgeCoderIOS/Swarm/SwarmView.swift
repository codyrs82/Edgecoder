import SwiftUI

struct SwarmView: View {
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @StateObject private var modelManager = LocalModelManager.shared
    @StateObject private var bt = BluetoothTransport.shared
    @State private var prompt = "Summarize my edge node contribution profile."
    @State private var enrollmentNodeId = ""
    @State private var enrollmentToken = ""
    @State private var enrollmentStatus = ""

    var body: some View {
        NavigationStack {
            Form {

                // ─────────────────────────────────────────
                // MARK: Compute offering (primary control)
                // ─────────────────────────────────────────
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Compute Offering")
                            .font(.headline)
                        Text(computeModeDescription)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)

                    Picker("Mode", selection: $swarmRuntime.computeMode) {
                        ForEach(ComputeMode.allCases) { mode in
                            Label(mode.rawValue, systemImage: modeIcon(mode))
                                .tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.vertical, 4)

                    if swarmRuntime.computeMode == .bluetoothLocal {
                        bluetoothStatusRow
                    }

                    if swarmRuntime.computeMode == .internet {
                        internetStatusRow
                    }
                }

                // ─────────────────────────────────────────
                // MARK: Runtime info
                // ─────────────────────────────────────────
                Section("Runtime") {
                    TextField("Agent ID", text: $swarmRuntime.agentId)
                        .textInputAutocapitalization(.never)
                    TextField("Coordinator URL", text: $swarmRuntime.selectedCoordinatorURL)
                        .textInputAutocapitalization(.never)
                    TextField("Registration token", text: $swarmRuntime.registrationToken)
                        .textInputAutocapitalization(.never)
                    SecureField("Mesh token (optional)", text: $swarmRuntime.meshToken)

                    LabeledContent("State", value: swarmRuntime.state.rawValue)
                    LabeledContent("Battery", value: "\(swarmRuntime.batteryPct)%")
                    LabeledContent("Low Power Mode", value: swarmRuntime.isLowPowerMode ? "on" : "off")
                    LabeledContent("External Power", value: swarmRuntime.isOnExternalPower ? "yes" : "no")
                    LabeledContent("Network", value: swarmRuntime.isNetworkReachable ? "reachable" : "offline")
                    LabeledContent("Heartbeats sent", value: String(swarmRuntime.heartbeatCount))
                    LabeledContent("Tasks observed", value: String(swarmRuntime.coordinatorTasksObserved))
                    LabeledContent(
                        "Last heartbeat",
                        value: swarmRuntime.lastHeartbeatAt?.formatted(date: .omitted, time: .standard) ?? "n/a"
                    )

                    Toggle("Run only when charging", isOn: $swarmRuntime.runOnlyWhileCharging)

                    Button(swarmRuntime.isReregistering ? "Re-registering..." : "Re-register agent") {
                        Task { await swarmRuntime.reregisterAgent() }
                    }
                    .disabled(swarmRuntime.isReregistering)
                }

                // ─────────────────────────────────────────
                // MARK: Local Model
                // ─────────────────────────────────────────
                Section("Local Model") {
                    TextField("Model", text: $modelManager.selectedModel)
                    LabeledContent("State", value: modelManager.state.rawValue)
                    LabeledContent("Runtime mode", value: "llama.cpp/Core ML scaffold")
                    Text(modelManager.statusText).font(.caption)
                    Button("Install lightweight model") {
                        Task { await modelManager.installLightweightModel() }
                    }
                    TextField("Prompt", text: $prompt, axis: .vertical)
                    Button("Run local inference") {
                        Task { await modelManager.runInference(prompt: prompt) }
                    }
                    if !modelManager.lastInferenceOutput.isEmpty {
                        Text(modelManager.lastInferenceOutput)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // ─────────────────────────────────────────
                // MARK: Coordinator discovery
                // ─────────────────────────────────────────
                Section("Coordinator discovery") {
                    if swarmRuntime.discoveredCoordinators.isEmpty {
                        Text("No coordinators discovered.")
                    } else {
                        ForEach(swarmRuntime.discoveredCoordinators, id: \.self) { coordinator in
                            VStack(alignment: .leading) {
                                Text(coordinator.coordinatorUrl).font(.subheadline)
                                Text("\(coordinator.peerId) | \(coordinator.source)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Button("Refresh coordinator list") {
                        Task { await swarmRuntime.discoverCoordinators() }
                    }
                }

                // ─────────────────────────────────────────
                // MARK: Node enrollment
                // ─────────────────────────────────────────
                Section("Node enrollment") {
                    TextField("Node ID", text: $enrollmentNodeId)
                        .textInputAutocapitalization(.never)
                    HStack {
                        Button("Generate enrollment token") {
                            Task { await enrollNode() }
                        }
                        .disabled(enrollmentNodeId.isEmpty)
                        Button("Use generated token") {
                            swarmRuntime.registrationToken = enrollmentToken
                            swarmRuntime.persistRuntimeSettings()
                        }
                        .disabled(enrollmentToken.isEmpty)
                    }
                    if !enrollmentToken.isEmpty {
                        Text(enrollmentToken)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                    if !enrollmentStatus.isEmpty {
                        Text(enrollmentStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // ─────────────────────────────────────────
                // MARK: Status
                // ─────────────────────────────────────────
                Section("Status") {
                    Text(swarmRuntime.statusText)
                        .foregroundStyle(.secondary)
                }

                // ─────────────────────────────────────────
                // MARK: Diagnostics
                // ─────────────────────────────────────────
                Section("Diagnostics") {
                    Toggle("Upload diagnostics to coordinator", isOn: $swarmRuntime.diagnosticsUploadEnabled)
                        .onChange(of: swarmRuntime.diagnosticsUploadEnabled) { _, _ in
                            swarmRuntime.persistRuntimeSettings()
                        }
                    LabeledContent("Registration token", value: swarmRuntime.registrationToken.isEmpty ? "missing" : "present")
                    LabeledContent("Mesh token", value: swarmRuntime.meshToken.isEmpty ? "missing" : "present")
                    LabeledContent(
                        "Last register attempt",
                        value: swarmRuntime.lastRegisterAt?.formatted(date: .omitted, time: .standard) ?? "n/a"
                    )
                    if !swarmRuntime.lastRegisterError.isEmpty {
                        Text(swarmRuntime.lastRegisterError)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                    if swarmRuntime.runtimeEvents.isEmpty {
                        Text("No runtime events yet.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(swarmRuntime.runtimeEvents.prefix(10).enumerated()), id: \.offset) { _, event in
                            Text(event)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Bluetooth event log (only when in BT Local mode)
                if swarmRuntime.computeMode == .bluetoothLocal && !bt.btEvents.isEmpty {
                    Section("Bluetooth Events") {
                        ForEach(Array(bt.btEvents.prefix(8).enumerated()), id: \.offset) { _, event in
                            Text(event)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Swarm")
            .task {
                if enrollmentNodeId.isEmpty {
                    enrollmentNodeId = swarmRuntime.agentId
                }
            }
        }
    }

    // MARK: - Sub-views

    @ViewBuilder
    private var bluetoothStatusRow: some View {
        HStack(spacing: 8) {
            Image(systemName: bt.isAdvertising ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash")
                .foregroundStyle(bt.isAdvertising ? .blue : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(bt.isAdvertising ? "Advertising to nearby devices" : "BT not advertising")
                    .font(.subheadline)
                if bt.connectedCentralCount > 0 {
                    Text("\(bt.connectedCentralCount) Mac(s) connected")
                        .font(.caption)
                        .foregroundStyle(.blue)
                } else {
                    Text("Waiting for a Mac to connect…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)

        Text("No internet or swarm rewards in this mode. Your phone's compute is available only to nearby EdgeCoder Mac nodes over Bluetooth.")
            .font(.caption)
            .foregroundStyle(.orange)
    }

    @ViewBuilder
    private var internetStatusRow: some View {
        HStack(spacing: 6) {
            Image(systemName: swarmRuntime.isNetworkReachable ? "wifi" : "wifi.slash")
                .foregroundStyle(swarmRuntime.isNetworkReachable ? .green : .orange)
            Text(swarmRuntime.isNetworkReachable
                 ? "Connected to internet swarm"
                 : "Offline — will auto-switch to Bluetooth Local")
                .font(.caption)
                .foregroundStyle(swarmRuntime.isNetworkReachable ? .secondary : .orange)
        }
    }

    // MARK: - Helpers

    private var computeModeDescription: String {
        switch swarmRuntime.computeMode {
        case .off:
            return "Not offering compute. The app runs in the background but does not participate in any tasks."
        case .internet:
            return "Offering compute to the EdgeCoder swarm over the internet. You earn rewards for completed tasks."
        case .bluetoothLocal:
            return "Offering compute to nearby Mac devices over Bluetooth — no internet required and no rewards."
        }
    }

    private func modeIcon(_ mode: ComputeMode) -> String {
        switch mode {
        case .off:           return "stop.circle"
        case .internet:      return "network"
        case .bluetoothLocal: return "bluetooth"
        }
    }

    // MARK: - Enrollment

    private func enrollNode() async {
        struct EnrollBody: Encodable {
            let nodeId: String
            let nodeKind: String
        }
        do {
            let payload: EnrollmentResponse = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/nodes/enroll",
                method: "POST",
                body: EnrollBody(nodeId: enrollmentNodeId, nodeKind: "agent")
            )
            enrollmentToken = payload.registrationToken
            enrollmentStatus = "Enrollment token created for \(payload.nodeId). Save immediately."
        } catch {
            enrollmentStatus = error.localizedDescription
        }
    }
}
