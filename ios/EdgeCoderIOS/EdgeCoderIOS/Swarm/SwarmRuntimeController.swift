import Foundation
import UIKit
import Network

// MARK: - Compute mode

/// Three-way compute offering mode.
/// - off:             No compute offered; runtime is idle.
/// - internet:        Standard swarm participation via coordinator over the internet.
/// - bluetoothLocal:  Serve compute to a nearby Mac/laptop over Bluetooth only.
///                    No coordinator rewards are earned in this mode.
enum ComputeMode: String, CaseIterable, Identifiable {
    case off             = "Off"
    case internet        = "On"
    case bluetoothLocal  = "Bluetooth Local"
    var id: String { rawValue }
}

// MARK: - Internal runtime state (distinct from ComputeMode)

enum SwarmRuntimeState: String {
    case stopped
    case running
    case paused
}

// MARK: - SwarmRuntimeController

@MainActor
final class SwarmRuntimeController: ObservableObject {
    static let shared = SwarmRuntimeController()

    // MARK: Published — compute mode (primary toggle)
    @Published var computeMode: ComputeMode = .off {
        didSet {
            persistRuntimeSettings()
            Task { await applyComputeMode() }
        }
    }

    // MARK: Published — runtime internals
    @Published var state: SwarmRuntimeState = .stopped
    @Published var runOnlyWhileCharging = false
    @Published var diagnosticsUploadEnabled = false
    @Published var statusText = "Swarm runtime stopped."
    @Published var discoveredCoordinators: [DiscoveryResponse.CoordinatorRecord] = []
    @Published var agentId: String = "iphone-\(UUID().uuidString.prefix(8))"
    @Published var registrationToken: String = ""
    @Published var meshToken: String = ""
    @Published var selectedCoordinatorURL: String = AppConfig.current.coordinatorBootstrapURL.absoluteString
    @Published var heartbeatCount = 0
    @Published var lastHeartbeatAt: Date?
    @Published var coordinatorTasksObserved = 0
    @Published var lastRegisterAt: Date?
    @Published var lastRegisterError = ""
    @Published var runtimeEvents: [String] = []
    @Published var isReregistering = false

    // MARK: Published — connectivity
    @Published var isNetworkReachable = true

    // MARK: Private
    private let api = APIClient.shared
    private let modelManager = LocalModelManager.shared
    private var runtimeTask: Task<Void, Never>?
    private let pathMonitor = NWPathMonitor()
    private let pathMonitorQueue = DispatchQueue(label: "io.edgecoder.pathmonitor", qos: .background)

    // MARK: - Defaults keys

    private enum DefaultsKey {
        static let agentId                 = "edgecoder.agentId"
        static let registrationToken       = "edgecoder.registrationToken"
        static let meshToken               = "edgecoder.meshToken"
        static let coordinatorURL          = "edgecoder.coordinatorURL"
        static let runOnlyWhileCharging    = "edgecoder.runOnlyWhileCharging"
        static let diagnosticsUploadEnabled = "edgecoder.diagnosticsUploadEnabled"
        static let heartbeatCount          = "edgecoder.heartbeatCount"
        static let coordinatorTasksObserved = "edgecoder.coordinatorTasksObserved"
        static let computeMode             = "edgecoder.computeMode"
    }

    // MARK: - Agent ID helper

    static func defaultIosAgentId() -> String {
        let deviceName = UIDevice.current.name
        let step1 = deviceName.lowercased().map { char -> Character in
            char.isLetter || char.isNumber ? char : "-"
        }
        let base = String(step1)
            .components(separatedBy: "-")
            .filter { !$0.isEmpty }
            .joined(separator: "-")
            .prefix(24)
        let unique = String((UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString)
            .replacingOccurrences(of: "-", with: "")
            .lowercased()
            .prefix(6))
        return base.isEmpty ? "ios-\(unique)" : "\(base)-\(unique)"
    }

    // MARK: - Init

    init() {
        // Restore agent ID
        if let value = UserDefaults.standard.string(forKey: DefaultsKey.agentId), !value.isEmpty {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalized.caseInsensitiveCompare("CRS-NODE-001") == .orderedSame ||
                normalized.uppercased().hasPrefix("CRS-NODE-") ||
                normalized.lowercased().hasPrefix("iphone-") ||
                normalized.caseInsensitiveCompare("iphone") == .orderedSame {
                agentId = Self.defaultIosAgentId()
            } else {
                agentId = normalized
            }
        } else {
            agentId = Self.defaultIosAgentId()
        }

        registrationToken = UserDefaults.standard.string(forKey: DefaultsKey.registrationToken) ?? ""
        meshToken         = UserDefaults.standard.string(forKey: DefaultsKey.meshToken) ?? ""
        if let value = UserDefaults.standard.string(forKey: DefaultsKey.coordinatorURL), !value.isEmpty {
            selectedCoordinatorURL = value
        }
        runOnlyWhileCharging     = UserDefaults.standard.object(forKey: DefaultsKey.runOnlyWhileCharging) as? Bool ?? false
        diagnosticsUploadEnabled = UserDefaults.standard.object(forKey: DefaultsKey.diagnosticsUploadEnabled) as? Bool ?? false
        heartbeatCount           = UserDefaults.standard.integer(forKey: DefaultsKey.heartbeatCount)
        coordinatorTasksObserved = UserDefaults.standard.integer(forKey: DefaultsKey.coordinatorTasksObserved)

        // Restore compute mode
        if let modeRaw = UserDefaults.standard.string(forKey: DefaultsKey.computeMode),
           let mode = ComputeMode(rawValue: modeRaw) {
            computeMode = mode
        }

        persistRuntimeSettings()
        startPathMonitor()
    }

    // MARK: - Network path monitor

    private func startPathMonitor() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let reachable = path.status == .satisfied
            Task { @MainActor in
                let wasReachable = self.isNetworkReachable
                self.isNetworkReachable = reachable

                // Auto-switch: if internet mode loses connectivity, downgrade to BT local.
                // If connectivity returns and we were in BT local due to auto-switch, stay put
                // (user must manually switch back — we don't silently escalate rewards mode).
                if !reachable && self.computeMode == .internet {
                    self.appendEvent("Network lost — switching to Bluetooth Local mode automatically.")
                    // Bypass the didSet to avoid a double applyComputeMode call
                    self.computeMode = .bluetoothLocal
                } else if reachable && !wasReachable && self.computeMode == .bluetoothLocal {
                    // Notify the user that internet is back; they can manually switch if desired.
                    self.appendEvent("Network restored. Switch to 'On' mode to rejoin the internet swarm.")
                }
            }
        }
        pathMonitor.start(queue: pathMonitorQueue)
    }

    // MARK: - Apply compute mode

    private func applyComputeMode() async {
        switch computeMode {
        case .off:
            stop()
        case .internet:
            if state != .running {
                await start()
            }
        case .bluetoothLocal:
            // Stop coordinator communication; BT transport takes over.
            if state == .running {
                runtimeTask?.cancel()
                runtimeTask = nil
                state = .paused
            }
            statusText = "Bluetooth Local mode: offering compute to nearby devices."
            appendEvent(statusText)
            // BluetoothTransport handles the actual compute serving.
            await BluetoothTransport.shared.startPeripheral(agentId: agentId, modelManager: modelManager)
        }
    }

    // MARK: - Enrollment

    func ensureEnrollment(force: Bool = false) async {
        let currentAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !currentAgentId.isEmpty else { return }
        if !force && !registrationToken.isEmpty { return }
        struct EnrollBody: Encodable {
            let nodeId: String
            let nodeKind: String
        }
        do {
            let payload: EnrollmentResponse = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/nodes/enroll",
                method: "POST",
                body: EnrollBody(nodeId: currentAgentId, nodeKind: "agent")
            )
            registrationToken = payload.registrationToken
            persistRuntimeSettings()
            appendEvent("Enrollment token refreshed for \(currentAgentId).")
        } catch {
            appendEvent("Enrollment refresh failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Coordinator discovery

    func discoverCoordinators() async {
        do {
            let payload: DiscoveryResponse = try await api.request(
                baseURL: api.config.controlPlaneBaseURL,
                path: "/network/coordinators",
                method: "GET"
            )
            discoveredCoordinators = payload.coordinators
            if let first = payload.coordinators.first?.coordinatorUrl {
                selectedCoordinatorURL = first
            }
            appendEvent("Coordinator discovery returned \(payload.coordinators.count) endpoint(s).")
        } catch {
            statusText = "Coordinator discovery failed: \(error.localizedDescription)"
            appendEvent(statusText)
        }
    }

    // MARK: - Start / Stop (internet mode)

    func start() async {
        if state == .running { return }
        if runOnlyWhileCharging && !isOnExternalPower {
            statusText = "Runtime blocked: connect power to start."
            return
        }
        if modelManager.state != .ready {
            await modelManager.installLightweightModel()
        }
        persistRuntimeSettings()
        runtimeTask?.cancel()
        runtimeTask = Task { [weak self] in
            await self?.runtimeLoop()
        }
        state = .running
        statusText = "Swarm runtime running with local model \(modelManager.selectedModel)."
        appendEvent(statusText)
        await discoverCoordinators()
    }

    func pause() {
        runtimeTask?.cancel()
        runtimeTask = nil
        state = .paused
        statusText = "Swarm runtime paused."
        appendEvent(statusText)
    }

    func stop() {
        runtimeTask?.cancel()
        runtimeTask = nil
        state = .stopped
        statusText = "Swarm runtime stopped."
        appendEvent(statusText)
        // Also stop BT peripheral if it was running
        Task { await BluetoothTransport.shared.stop() }
    }

    // MARK: - Re-register

    func reregisterAgent() async {
        if isReregistering { return }
        let currentAgentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !currentAgentId.isEmpty else {
            statusText = "Re-register failed: missing Agent ID."
            appendEvent(statusText)
            return
        }
        isReregistering = true
        defer { isReregistering = false }

        appendEvent("Manual re-register started for \(currentAgentId).")
        meshToken = ""
        registrationToken = ""
        persistRuntimeSettings()

        await ensureEnrollment(force: true)
        guard !registrationToken.isEmpty else {
            statusText = "Re-register failed: could not get a registration token."
            appendEvent(statusText)
            return
        }

        let registered = await registerAgent()
        if registered {
            statusText = "Re-register complete."
            appendEvent(statusText)
            if state == .running {
                await sendHeartbeat()
            }
        } else {
            appendEvent("Re-register failed. See Last register attempt for details.")
        }
    }

    // MARK: - Battery / Power

    var batteryPct: Int {
        UIDevice.current.isBatteryMonitoringEnabled = true
        return Int(max(0, UIDevice.current.batteryLevel) * 100)
    }

    var isLowPowerMode: Bool {
        ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    var isOnExternalPower: Bool {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let s = UIDevice.current.batteryState
        return s == .charging || s == .full
    }

    // MARK: - Persistence

    func persistRuntimeSettings() {
        UserDefaults.standard.set(agentId,                 forKey: DefaultsKey.agentId)
        UserDefaults.standard.set(registrationToken,       forKey: DefaultsKey.registrationToken)
        UserDefaults.standard.set(meshToken,               forKey: DefaultsKey.meshToken)
        UserDefaults.standard.set(selectedCoordinatorURL,  forKey: DefaultsKey.coordinatorURL)
        UserDefaults.standard.set(runOnlyWhileCharging,    forKey: DefaultsKey.runOnlyWhileCharging)
        UserDefaults.standard.set(diagnosticsUploadEnabled, forKey: DefaultsKey.diagnosticsUploadEnabled)
        UserDefaults.standard.set(heartbeatCount,          forKey: DefaultsKey.heartbeatCount)
        UserDefaults.standard.set(coordinatorTasksObserved, forKey: DefaultsKey.coordinatorTasksObserved)
        UserDefaults.standard.set(computeMode.rawValue,    forKey: DefaultsKey.computeMode)
    }

    // MARK: - Runtime loop (internet mode)

    private func runtimeLoop() async {
        while !Task.isCancelled {
            // Exit loop if mode changed away from internet
            guard computeMode == .internet else { break }
            let registered = await registerAgent()
            if registered {
                await sendHeartbeat()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            } else {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    // MARK: - Public heartbeat entry point (used by background tasks)

    /// Safe to call from a BGTask: sends a heartbeat only if in internet mode and registered.
    func sendHeartbeatIfNeeded() async {
        guard computeMode == .internet else { return }
        if meshToken.isEmpty {
            _ = await registerAgent()
        }
        if !meshToken.isEmpty {
            await sendHeartbeat()
        }
    }

    // MARK: - Register

    private func registerAgent() async -> Bool {
        if !meshToken.isEmpty { return true }
        lastRegisterAt = Date()
        lastRegisterError = ""
        appendEvent("Registering agent \(agentId)...")
        let payload: [String: Any] = [
            "agentId": agentId,
            "os": "ios",
            "version": "1.0.0",
            "mode": "swarm-only",
            "registrationToken": registrationToken,
            "localModelProvider": "ollama-local",
            "clientType": "edgecoder-ios",
            "maxConcurrentTasks": 1,
            "powerTelemetry": currentPowerTelemetry()
        ]
        do {
            let response = try await postCoordinator(path: "/register", payload: payload)
            if let accepted = response["accepted"] as? Bool, accepted == false {
                statusText = "Register rejected by coordinator."
                lastRegisterError = statusText
                appendEvent(statusText)
                return false
            }
            if let issuedMeshToken = response["meshToken"] as? String, !issuedMeshToken.isEmpty {
                meshToken = issuedMeshToken
                persistRuntimeSettings()
                appendEvent("Mesh token issued by coordinator.")
            }
            appendEvent("Register succeeded.")
            return true
        } catch is CancellationError {
            return false
        } catch {
            if let apiError = error as? APIClientError,
               case .serverError(let message) = apiError,
               (message.contains("node_not_enrolled") ||
                message.contains("registration_token_invalid") ||
                message.contains("node_not_activated")) {
                meshToken = ""
                registrationToken = ""
                persistRuntimeSettings()
                await ensureEnrollment(force: true)
                statusText = "Register blocked by enrollment state. Re-enrolled and retrying..."
                lastRegisterError = statusText
                appendEvent(statusText)
                return false
            }
            statusText = "Register failed: \(error.localizedDescription)"
            lastRegisterError = statusText
            appendEvent(statusText)
            return false
        }
    }

    // MARK: - Heartbeat

    internal func sendHeartbeat() async {
        let payload: [String: Any] = [
            "agentId": agentId,
            "powerTelemetry": currentPowerTelemetry()
        ]
        do {
            let hb = try await postCoordinator(path: "/heartbeat", payload: payload)
            heartbeatCount += 1
            lastHeartbeatAt = Date()
            persistRuntimeSettings()
            statusText = "Heartbeat sent (\(Date().formatted(date: .omitted, time: .standard)))."
            appendEvent(statusText)

            if let orch = hb["orchestration"] as? [String: Any],
               let pending = orch["pending"] as? Bool, pending {
                await handleOrchestration(orch)
            }

            await observeCoordinatorPull()
        } catch is CancellationError {
            return
        } catch {
            if let apiError = error as? APIClientError,
               case .serverError(let message) = apiError,
               message.contains("mesh_unauthorized") {
                meshToken = ""
                persistRuntimeSettings()
                statusText = "Heartbeat auth expired. Re-registering..."
                appendEvent(statusText)
                return
            }
            statusText = "Heartbeat failed: \(error.localizedDescription)"
            appendEvent(statusText)
        }
    }

    // MARK: - Orchestration

    private func handleOrchestration(_ orch: [String: Any]) async {
        let provider    = orch["provider"]     as? String ?? ""
        let model       = orch["model"]        as? String ?? modelManager.selectedModel
        let autoInstall = orch["autoInstall"]  as? Bool   ?? true

        guard provider == "ollama-local" && autoInstall else { return }

        appendEvent("Orchestration: switching to \(provider) / \(model)…")
        await reportOrchestrationStatus(phase: "starting", message: "Preparing local model…")

        if !model.isEmpty && model != modelManager.selectedModel {
            modelManager.selectedModel = model
        }

        if modelManager.state != .ready {
            await reportOrchestrationStatus(phase: "installing_model", message: "Downloading model \(model)…")
            await modelManager.installLightweightModel()
        }

        if modelManager.state == .ready {
            await reportOrchestrationStatus(phase: "done", message: "Model switch complete. \(model) ready.")
            appendEvent("Orchestration complete: \(model) ready.")
            _ = try? await postCoordinator(
                path: "/orchestration/agents/\(agentId)/ack",
                payload: ["ok": true]
            )
        } else {
            let errMsg = "Model load failed: \(modelManager.statusText)"
            await reportOrchestrationStatus(phase: "error", message: errMsg)
            appendEvent("Orchestration error: \(errMsg)")
            _ = try? await postCoordinator(
                path: "/orchestration/agents/\(agentId)/ack",
                payload: ["ok": false, "error": errMsg]
            )
        }
    }

    private func reportOrchestrationStatus(phase: String, message: String, progressPct: Int? = nil) async {
        var payload: [String: Any] = [
            "phase":   String(phase.prefix(64)),
            "message": String(message.prefix(512))
        ]
        if let pct = progressPct { payload["progressPct"] = pct }
        _ = try? await postCoordinator(
            path: "/orchestration/agents/\(agentId)/status",
            payload: payload
        )
    }

    // MARK: - Pull / task execution

    private func observeCoordinatorPull() async {
        do {
            let payload: [String: Any] = ["agentId": agentId]
            let response = try await postCoordinator(path: "/pull", payload: payload)
            guard let subtask   = response["subtask"] as? [String: Any],
                  let taskId    = subtask["taskId"]   as? String,
                  let subtaskId = subtask["id"]       as? String,
                  let prompt    = subtask["prompt"]   as? String else { return }

            coordinatorTasksObserved += 1
            persistRuntimeSettings()
            appendEvent("Task claimed: \(subtaskId.prefix(8))… — running local inference.")
            await executeSubtask(taskId: taskId, subtaskId: subtaskId, prompt: prompt)
        } catch {
            // Non-fatal; ignore pull errors
        }
    }

    private func executeSubtask(taskId: String, subtaskId: String, prompt: String) async {
        let startMs = Int(Date().timeIntervalSince1970 * 1000)

        if modelManager.state != .ready {
            await modelManager.installLightweightModel()
        }

        var output = ""
        var ok = false

        if modelManager.state == .ready {
            await modelManager.runInference(prompt: prompt, maxTokens: 512)
            output = modelManager.lastInferenceOutput
            ok = !output.isEmpty && output != "[empty response]"
        } else {
            output = "Local model unavailable: \(modelManager.statusText)"
        }

        let durationMs = Int(Date().timeIntervalSince1970 * 1000) - startMs

        do {
            let resultPayload: [String: Any] = [
                "agentId":   agentId,
                "taskId":    taskId,
                "subtaskId": subtaskId,
                "ok":        ok,
                "output":    output,
                "durationMs": durationMs
            ]
            _ = try await postCoordinator(path: "/result", payload: resultPayload)
            appendEvent("Task \(subtaskId.prefix(8))… complete (ok=\(ok), \(durationMs)ms).")
        } catch {
            appendEvent("Task result POST failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Networking helpers

    private func postCoordinator(path: String, payload: [String: Any]) async throws -> [String: Any] {
        guard let url = URL(string: selectedCoordinatorURL + path) else {
            throw APIClientError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !meshToken.isEmpty {
            request.setValue(meshToken, forHTTPHeaderField: "x-mesh-token")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        if !(200...299).contains(http.statusCode) {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorMessage = object["error"] as? String {
                let reason = object["reason"] as? String
                if let reason, !reason.isEmpty {
                    throw APIClientError.serverError("Coordinator \(http.statusCode): \(errorMessage) (\(reason))")
                }
                throw APIClientError.serverError("Coordinator \(http.statusCode): \(errorMessage)")
            }
            throw APIClientError.serverError("Coordinator returned \(http.statusCode).")
        }
        if data.isEmpty { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: - Telemetry helpers

    private func currentPowerTelemetry() -> [String: Any] {
        [
            "onExternalPower": isOnExternalPower,
            "batteryLevelPct": batteryPct,
            "lowPowerMode":    isLowPowerMode,
            "updatedAtMs":     Int(Date().timeIntervalSince1970 * 1000)
        ]
    }

    // MARK: - Event log

    func appendEvent(_ message: String) {
        let now = Date()
        let line = "\(now.formatted(date: .omitted, time: .standard)) | \(message)"
        runtimeEvents.insert(line, at: 0)
        if runtimeEvents.count > 40 {
            runtimeEvents = Array(runtimeEvents.prefix(40))
        }
        if diagnosticsUploadEnabled {
            let eventAtMs = Int(now.timeIntervalSince1970 * 1000)
            Task { [weak self] in
                await self?.postDiagnosticsEvent(message: message, eventAtMs: eventAtMs)
            }
        }
    }

    private func postDiagnosticsEvent(message: String, eventAtMs: Int) async {
        guard diagnosticsUploadEnabled, !meshToken.isEmpty else { return }
        let payload: [String: Any] = [
            "agentId":      agentId,
            "events":       [["eventAtMs": eventAtMs, "message": message]],
            "source":       "edgecoder-ios",
            "runtimeState": state.rawValue,
            "modelState":   modelManager.state.rawValue
        ]
        _ = try? await postCoordinator(path: "/agent/diagnostics", payload: payload)
    }
}
