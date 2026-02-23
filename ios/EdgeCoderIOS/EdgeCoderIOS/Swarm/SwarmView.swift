import SwiftUI

struct SwarmView: View {
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @StateObject private var modelManager = LocalModelManager()
    @State private var prompt = "Summarize my edge node contribution profile."
    @State private var enrollmentNodeId = ""
    @State private var enrollmentToken = ""
    @State private var enrollmentStatus = ""

    var body: some View {
        NavigationStack {
            Form {
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
                    LabeledContent("Heartbeats sent", value: String(swarmRuntime.heartbeatCount))
                    LabeledContent("Tasks observed", value: String(swarmRuntime.coordinatorTasksObserved))
                    LabeledContent(
                        "Last heartbeat",
                        value: swarmRuntime.lastHeartbeatAt?.formatted(date: .omitted, time: .standard) ?? "n/a"
                    )

                    Toggle("Run only when charging", isOn: $swarmRuntime.runOnlyWhileCharging)

                    HStack {
                        Button("Start") { Task { await swarmRuntime.start() } }
                            .disabled(swarmRuntime.state == .running)
                        Button("Pause") { swarmRuntime.pause() }
                            .disabled(swarmRuntime.state != .running)
                        Button("Stop", role: .destructive) { swarmRuntime.stop() }
                            .disabled(swarmRuntime.state == .stopped)
                    }
                    Button(swarmRuntime.isReregistering ? "Re-registering..." : "Re-register agent") {
                        Task { await swarmRuntime.reregisterAgent() }
                    }
                    .disabled(swarmRuntime.isReregistering)
                }

                Section("Local Model") {
                    ModelPickerView(modelManager: modelManager)
                    ModelStatusBanner(modelManager: modelManager)
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

                Section("Status") {
                    Text(swarmRuntime.statusText)
                        .foregroundStyle(.secondary)
                }

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
            }
            .navigationTitle("Swarm")
            .task {
                if enrollmentNodeId.isEmpty {
                    enrollmentNodeId = swarmRuntime.agentId
                }
            }
        }
    }

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
