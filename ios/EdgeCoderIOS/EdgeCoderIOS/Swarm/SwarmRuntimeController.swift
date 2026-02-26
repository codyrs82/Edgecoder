import Foundation
import UIKit

enum SwarmRuntimeState: String {
    case stopped
    case running
    case paused
}

@MainActor
final class SwarmRuntimeController: ObservableObject {
    static let shared = SwarmRuntimeController()

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
    @Published var tasksCompleted = 0
    @Published var tasksFailed = 0
    @Published var creditsEarned = 0
    @Published var lastTaskAt: Date?
    @Published var isProcessingTask = false
    @Published var lastRegisterAt: Date?
    @Published var lastRegisterError = ""
    @Published var runtimeEvents: [String] = []
    @Published var isReregistering = false
    @Published var consecutiveHeartbeatFailures = 0

    let bleMeshManager = BLEMeshManager.shared
    private let api = APIClient.shared
    let modelManager = LocalModelManager()
    private var runtimeTask: Task<Void, Never>?
    @Published var autoStartEnabled: Bool = true

    var isLocalCoordinator: Bool {
        let url = selectedCoordinatorURL.lowercased()
        return url.contains("localhost") || url.contains("127.0.0.1") ||
               url.hasPrefix("http://192.168.") || url.hasPrefix("http://10.")
    }

    private enum DefaultsKey {
        static let agentId = "edgecoder.agentId"
        static let registrationToken = "edgecoder.registrationToken"
        static let meshToken = "edgecoder.meshToken"
        static let coordinatorURL = "edgecoder.coordinatorURL"
        static let runOnlyWhileCharging = "edgecoder.runOnlyWhileCharging"
        static let diagnosticsUploadEnabled = "edgecoder.diagnosticsUploadEnabled"
        static let heartbeatCount = "edgecoder.heartbeatCount"
        static let coordinatorTasksObserved = "edgecoder.coordinatorTasksObserved"
        static let tasksCompleted = "edgecoder.tasksCompleted"
        static let tasksFailed = "edgecoder.tasksFailed"
        static let creditsEarned = "edgecoder.creditsEarned"
        static let autoStartEnabled = "edgecoder.autoStartEnabled"
    }

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

    init() {
        if let value = UserDefaults.standard.string(forKey: DefaultsKey.agentId), !value.isEmpty {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            // Migrate legacy/shared IDs to a device-specific iOS node ID.
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
        meshToken = UserDefaults.standard.string(forKey: DefaultsKey.meshToken) ?? ""
        if let value = UserDefaults.standard.string(forKey: DefaultsKey.coordinatorURL), !value.isEmpty {
            // Migrate away from defunct coordinator URLs that no longer resolve.
            let defunct = [
                "coordinator.edgecoder.io",
                "control.edgecoder.io"
            ]
            if defunct.contains(where: { value.contains($0) }) {
                selectedCoordinatorURL = AppConfig.current.coordinatorBootstrapURL.absoluteString
                // Tokens from the old coordinator are invalid on the new one.
                registrationToken = ""
                meshToken = ""
            } else {
                selectedCoordinatorURL = value
            }
        }
        runOnlyWhileCharging = UserDefaults.standard.object(forKey: DefaultsKey.runOnlyWhileCharging) as? Bool ?? false
        diagnosticsUploadEnabled = UserDefaults.standard.object(forKey: DefaultsKey.diagnosticsUploadEnabled) as? Bool ?? false
        heartbeatCount = UserDefaults.standard.integer(forKey: DefaultsKey.heartbeatCount)
        coordinatorTasksObserved = UserDefaults.standard.integer(forKey: DefaultsKey.coordinatorTasksObserved)
        tasksCompleted = UserDefaults.standard.integer(forKey: DefaultsKey.tasksCompleted)
        tasksFailed = UserDefaults.standard.integer(forKey: DefaultsKey.tasksFailed)
        creditsEarned = UserDefaults.standard.integer(forKey: DefaultsKey.creditsEarned)
        autoStartEnabled = UserDefaults.standard.object(forKey: DefaultsKey.autoStartEnabled) as? Bool ?? true
        persistRuntimeSettings()
    }

    /// Called after enrollment is confirmed. Auto-starts the swarm runtime if enabled.
    func autoStartIfReady() async {
        guard autoStartEnabled else { return }
        guard state == .stopped else { return }
        guard isLocalCoordinator || !registrationToken.isEmpty else { return }
        await start()
    }

    /// Enroll this device with the portal. Call when user is authenticated and token is missing.
    func ensureEnrollment(force: Bool = false) async {
        guard !isLocalCoordinator else {
            appendEvent("Skipping portal enrollment for local coordinator.")
            return
        }
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
            // Silent fail; user can manually enroll from Swarm tab
        }
    }

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

    func start() async {
        if state == .running {
            statusText = "Swarm runtime is already running."
            return
        }
        if runOnlyWhileCharging && !isOnExternalPower {
            statusText = "Runtime blocked: connect power to start."
            return
        }
        // Model activation is handled separately via LocalModelManager.activate(modelId:)
        persistRuntimeSettings()
        appendEvent("Starting runtime → coordinator: \(selectedCoordinatorURL), token: \(registrationToken.isEmpty ? "empty" : "present"), meshToken: \(meshToken.isEmpty ? "empty" : "present")")
        runtimeTask?.cancel()
        runtimeTask = Task { [weak self] in
            await self?.runtimeLoop()
        }
        state = .running
        statusText = "Swarm runtime running with local model \(modelManager.selectedModel)."
        appendEvent(statusText)
        await discoverCoordinators()
        bleMeshManager.start()
        bleMeshManager.startAdvertising(
            agentId: agentId,
            model: modelManager.selectedModel,
            modelParamSize: modelManager.selectedModelParamSize
        )
        bleMeshManager.startScanning()

        // Wire BLE task handler to local inference
        let mgr = modelManager
        bleMeshManager.taskHandler = { prompt in
            await mgr.generate(prompt: prompt, maxTokens: 512)
        }

        // One-time BLE outbound task test: wait for peer discovery, then send a task to Mac
        Task { [weak self] in
            guard let self else { return }
            // Wait for peer discovery (up to 30s)
            for _ in 0..<30 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if !self.bleMeshManager.discoveredPeers.isEmpty { break }
            }
            guard let macPeer = self.bleMeshManager.discoveredPeers.first else {
                self.appendEvent("[BLE-TEST] no BLE peers discovered, skipping outbound test")
                return
            }
            self.appendEvent("[BLE-TEST] sending task to \(macPeer.agentId) over BLE...")
            let result = await self.bleMeshManager.sendTask(
                toAgentId: macPeer.agentId,
                prompt: "Write a Python function called fibonacci(n) that returns a list of the first n Fibonacci numbers. Include a docstring.",
                tag: "test"
            )
            self.appendEvent("[BLE-TEST] response from \(macPeer.agentId): ok=\(result.ok), output=\(result.output.prefix(150))")
        }
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
        bleMeshManager.stop()
        state = .stopped
        statusText = "Swarm runtime stopped."
        appendEvent(statusText)
    }

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
        selectedCoordinatorURL = AppConfig.current.coordinatorBootstrapURL.absoluteString
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

    var batteryPct: Int {
        UIDevice.current.isBatteryMonitoringEnabled = true
        return Int(max(0, UIDevice.current.batteryLevel) * 100)
    }

    var isLowPowerMode: Bool {
        ProcessInfo.processInfo.isLowPowerModeEnabled
    }

    var isOnExternalPower: Bool {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let state = UIDevice.current.batteryState
        return state == .charging || state == .full
    }

    func persistRuntimeSettings() {
        UserDefaults.standard.set(agentId, forKey: DefaultsKey.agentId)
        UserDefaults.standard.set(registrationToken, forKey: DefaultsKey.registrationToken)
        UserDefaults.standard.set(meshToken, forKey: DefaultsKey.meshToken)
        UserDefaults.standard.set(selectedCoordinatorURL, forKey: DefaultsKey.coordinatorURL)
        UserDefaults.standard.set(runOnlyWhileCharging, forKey: DefaultsKey.runOnlyWhileCharging)
        UserDefaults.standard.set(diagnosticsUploadEnabled, forKey: DefaultsKey.diagnosticsUploadEnabled)
        UserDefaults.standard.set(autoStartEnabled, forKey: DefaultsKey.autoStartEnabled)
        UserDefaults.standard.set(heartbeatCount, forKey: DefaultsKey.heartbeatCount)
        UserDefaults.standard.set(coordinatorTasksObserved, forKey: DefaultsKey.coordinatorTasksObserved)
        UserDefaults.standard.set(tasksCompleted, forKey: DefaultsKey.tasksCompleted)
        UserDefaults.standard.set(tasksFailed, forKey: DefaultsKey.tasksFailed)
        UserDefaults.standard.set(creditsEarned, forKey: DefaultsKey.creditsEarned)
    }

    private func runtimeLoop() async {
        while !Task.isCancelled {
            let registered = await registerAgent()
            if registered {
                await sendHeartbeat()
                // Poll for tasks between heartbeats (3 polls per 15s cycle)
                for _ in 0..<3 {
                    guard !Task.isCancelled else { break }
                    await pollAndExecuteTask()
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            } else {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

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
                // Enrollment/token drift can happen after node-id migration or stale local token.
                // Re-enroll and retry loop shortly.
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

    private func sendHeartbeat() async {
        let payload: [String: Any] = [
            "agentId": agentId,
            "powerTelemetry": currentPowerTelemetry(),
            "activeModel": modelManager.selectedModel,
            "activeModelParamSize": modelManager.selectedModelParamSize,
            "modelSwapInProgress": modelManager.state == .loading
        ]
        do {
            _ = try await postCoordinator(path: "/heartbeat", payload: payload)
            heartbeatCount += 1
            lastHeartbeatAt = Date()
            consecutiveHeartbeatFailures = 0
            persistRuntimeSettings()
            statusText = "Heartbeat sent (\(Date().formatted(date: .omitted, time: .standard)))."
            appendEvent(statusText)
            if bleMeshManager.isOffline {
                bleMeshManager.isOffline = false
                bleMeshManager.stopScanning()
                appendEvent("Back online — syncing offline ledger.")
                await syncOfflineLedger()
            }
        } catch is CancellationError {
            return
        } catch {
            consecutiveHeartbeatFailures += 1
            if consecutiveHeartbeatFailures >= 3 && !bleMeshManager.isOffline {
                bleMeshManager.isOffline = true
                bleMeshManager.startScanning()
                appendEvent("Offline detected (\(consecutiveHeartbeatFailures) failures) — BLE mesh scanning started.")
            }
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

    /// Poll for a task and execute it if one is available.
    private func pollAndExecuteTask() async {
        guard modelManager.state == .ready else { return }
        guard !isProcessingTask else { return }

        do {
            let pullPayload: [String: Any] = ["agentId": agentId]
            let response = try await postCoordinator(path: "/pull", payload: pullPayload)

            guard let subtask = response["subtask"] as? [String: Any] else {
                return // No task available — idle
            }

            let subtaskId = subtask["id"] as? String ?? ""
            let taskId = subtask["taskId"] as? String ?? ""
            let input = subtask["input"] as? String ?? ""

            guard !subtaskId.isEmpty, !input.isEmpty else { return }

            coordinatorTasksObserved += 1
            isProcessingTask = true
            appendEvent("Task \(subtaskId.prefix(8))… pulled — running inference.")

            // Execute inference
            let result = await modelManager.generate(prompt: input, maxTokens: 512)

            // Build result payload matching coordinator /result schema
            let resultPayload: [String: Any] = [
                "subtaskId": subtaskId,
                "taskId": taskId,
                "agentId": agentId,
                "ok": result.ok,
                "output": result.output,
                "durationMs": result.durationMs
            ]

            // POST result back to coordinator
            _ = try await postCoordinator(path: "/result", payload: resultPayload)

            lastTaskAt = Date()
            let earnedCredits = Int(max(0.5, modelManager.selectedModelParamSize))
            if result.ok {
                tasksCompleted += 1
                creditsEarned += earnedCredits
                appendEvent("Task \(subtaskId.prefix(8))… completed (\(result.durationMs)ms) — +\(earnedCredits) credits")
            } else {
                tasksFailed += 1
                let failCredits = max(1, earnedCredits / 2)
                creditsEarned += failCredits
                appendEvent("Task \(subtaskId.prefix(8))… failed (\(result.durationMs)ms) — +\(failCredits) credits")
            }
            isProcessingTask = false
            persistRuntimeSettings()
        } catch is CancellationError {
            isProcessingTask = false
        } catch {
            isProcessingTask = false
            // Non-fatal; will retry on next poll cycle
            appendEvent("Task poll/exec error: \(error.localizedDescription)")
        }
    }

    private func syncOfflineLedger() async {
        let ledger = OfflineLedger.shared
        let pending = ledger.pending()
        guard !pending.isEmpty else { return }
        appendEvent("Syncing \(pending.count) offline transaction(s) to coordinator.")
        let txDicts: [[String: Any]] = pending.map { tx in
            [
                "txId": tx.txId,
                "requesterId": tx.requesterId,
                "providerId": tx.providerId,
                "requesterAccountId": tx.requesterAccountId,
                "providerAccountId": tx.providerAccountId,
                "credits": tx.credits,
                "cpuSeconds": tx.cpuSeconds,
                "taskHash": tx.taskHash,
                "timestamp": tx.timestamp,
                "requesterSignature": tx.requesterSignature,
                "providerSignature": tx.providerSignature
            ]
        }
        let payload: [String: Any] = ["transactions": txDicts]
        do {
            let response = try await postCoordinator(path: "/credits/ble-sync", payload: payload)
            let syncedIds = (response["syncedTxIds"] as? [String]) ?? pending.map(\.txId)
            ledger.markSynced(syncedIds)
            appendEvent("Offline ledger sync complete — \(syncedIds.count) transaction(s) confirmed.")
        } catch {
            appendEvent("Offline ledger sync failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Chat Task Submission (used by ChatRouter)

    /// Submit a chat prompt to the coordinator task queue and poll for the result.
    func submitChatTask(prompt: String, requestedModel: String? = nil) async throws -> (output: String, taskId: String) {
        let taskId = "chat-\(Int(Date().timeIntervalSince1970 * 1000))"
        var submitPayload: [String: Any] = [
            "taskId": taskId,
            "prompt": prompt,
            "language": "python",
            "submitterAccountId": agentId,
            "projectId": "chat-requests",
            "resourceClass": "cpu",
            "priority": 60,
            "subtasks": [["prompt": prompt, "language": "python"]]
        ]
        if let model = requestedModel {
            submitPayload["requestedModel"] = model
        }

        let submitResponse = try await postCoordinator(path: "/tasks", payload: submitPayload)

        guard let returnedTaskId = submitResponse["taskId"] as? String,
              let subtasks = submitResponse["subtasks"] as? [String],
              let subtaskId = subtasks.first else {
            throw APIClientError.serverError("Swarm: no subtaskId returned")
        }

        // Poll for result — up to 90s
        let pollPath = "/tasks/\(returnedTaskId)/subtasks/\(subtaskId)/result"
        let deadline = Date().addingTimeInterval(90)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            do {
                let pollResponse = try await postCoordinator(path: pollPath, payload: [:])
                if let output = pollResponse["output"] as? String {
                    return (output: output, taskId: returnedTaskId)
                }
            } catch {
                // Continue polling
            }
        }

        throw APIClientError.serverError("Swarm task timed out after 90s")
    }

    func postCoordinator(path: String, payload: [String: Any]) async throws -> [String: Any] {
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

    private func currentPowerTelemetry() -> [String: Any] {
        [
            "onExternalPower": isOnExternalPower,
            "batteryLevelPct": batteryPct,
            "lowPowerMode": isLowPowerMode,
            "updatedAtMs": Int(Date().timeIntervalSince1970 * 1000)
        ]
    }

    private func appendEvent(_ message: String) {
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
        guard diagnosticsUploadEnabled else { return }
        guard !meshToken.isEmpty else { return }
        let payload: [String: Any] = [
            "agentId": agentId,
            "events": [
                [
                    "eventAtMs": eventAtMs,
                    "message": message
                ]
            ],
            "source": "edgecoder-ios",
            "runtimeState": state.rawValue,
            "modelState": modelManager.state.rawValue
        ]
        _ = try? await postCoordinator(path: "/agent/diagnostics", payload: payload)
    }
}
