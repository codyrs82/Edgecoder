import CryptoKit
import Foundation
import Security
import UIKit

enum SwarmRuntimeState: String {
    case stopped
    case running
    case paused
}

/// Hosting on the iPhone, only while the phone is on external power (charging or full,
/// HostingPowerPolicy): coordinator jobs (/pull -> local model -> /result) and serving nearby machines
/// over Bluetooth (BLEMeshManager advertising and running their prompts). Unplugging stops both at
/// once: no new job is pulled, advertising stops and new Bluetooth prompts are refused (a job or
/// prompt already running finishes and replies); plugging back in resumes both. The coordinator
/// enforces the same rule for jobs: /pull gives an iOS agent whose latest power telemetry is not on
/// external power no job. Registration, heartbeats, Bluetooth scanning (the phone's own requests to
/// nearby machines when offline) and offline ledger sync run on battery too.
@MainActor
final class SwarmRuntimeController: ObservableObject {
    static let shared = SwarmRuntimeController()

    @Published var state: SwarmRuntimeState = .stopped
    @Published var diagnosticsUploadEnabled = false
    @Published var statusText = "Hosting stopped."
    @Published var discoveredCoordinators: [DiscoveryResponse.CoordinatorRecord] = []
    @Published var agentId: String = "iphone-\(UUID().uuidString.prefix(8))"
    @Published var registrationToken: String = ""
    @Published var meshToken: String = ""
    /// Registered with the coordinator this session. Coordinators no longer hand agents a mesh
    /// token (agents sign every request with their own key), so a token is not the signal.
    @Published var isRegistered = false
    /// Swarm features are available: registered, or an operator-configured mesh token is set.
    var isSwarmReady: Bool { isRegistered || !meshToken.isEmpty }
    @Published var selectedCoordinatorURL: String = AppConfig.current.coordinatorBootstrapURL.absoluteString
    @Published var lastHeartbeatAt: Date?
    /// On external power (charging or full), kept current from UIDevice battery-state notifications.
    @Published private(set) var isCharging = false
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
    /// #64: Ed25519 key that signs every coordinator request; its public key is sent in /register.
    private var signingKey: Curve25519.Signing.PrivateKey?

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
        static let diagnosticsUploadEnabled = "edgecoder.diagnosticsUploadEnabled"
        /// Settings of older builds, cleared on launch: charging is now required for coordinator jobs
        /// (no toggle), and heartbeats are no longer counted on screen.
        static let retired = ["edgecoder.runOnlyWhileCharging", "edgecoder.heartbeatCount"]
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
        registrationToken = RuntimeSecretStore.load(DefaultsKey.registrationToken)
        meshToken = RuntimeSecretStore.load(DefaultsKey.meshToken)
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
        diagnosticsUploadEnabled = UserDefaults.standard.object(forKey: DefaultsKey.diagnosticsUploadEnabled) as? Bool ?? false
        for key in DefaultsKey.retired {
            UserDefaults.standard.removeObject(forKey: key)
        }
        coordinatorTasksObserved = UserDefaults.standard.integer(forKey: DefaultsKey.coordinatorTasksObserved)
        tasksCompleted = UserDefaults.standard.integer(forKey: DefaultsKey.tasksCompleted)
        tasksFailed = UserDefaults.standard.integer(forKey: DefaultsKey.tasksFailed)
        creditsEarned = UserDefaults.standard.integer(forKey: DefaultsKey.creditsEarned)
        autoStartEnabled = UserDefaults.standard.object(forKey: DefaultsKey.autoStartEnabled) as? Bool ?? true
        persistRuntimeSettings()
        UIDevice.current.isBatteryMonitoringEnabled = true
        isCharging = isOnExternalPower
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(batteryStateDidChange),
            name: UIDevice.batteryStateDidChangeNotification,
            object: nil
        )
    }

    @objc private func batteryStateDidChange() {
        refreshPowerState()
    }

    /// Plugging in or unplugging: pulling follows at once (the loop checks `isCharging` before every
    /// pull), Bluetooth serving starts or stops, and a heartbeat tells the coordinator the new power
    /// state right away. Also called before a Bluetooth prompt runs, since a battery notification can
    /// arrive late when Bluetooth wakes the app in the background. Returns whether the phone may host.
    @discardableResult
    func refreshPowerState() -> Bool {
        let charging = isOnExternalPower
        guard charging != isCharging else { return charging }
        isCharging = charging
        appendEvent(charging
            ? "Charging: network jobs and Bluetooth serving resume."
            : "Unplugged: no new network jobs or Bluetooth requests until charging.")
        applyBluetoothServing()
        guard state == .running, isSwarmReady else { return charging }
        Task { [weak self] in await self?.sendHeartbeat() }
        return charging
    }

    /// Serve nearby machines over Bluetooth while hosting is on and the phone is charging; stop
    /// serving otherwise. Scanning (this phone's own requests) is left alone.
    private func applyBluetoothServing() {
        guard state != .stopped, isCharging else {
            if bleMeshManager.isServing { bleMeshManager.stopServing() }
            return
        }
        guard !bleMeshManager.isServing else { return }
        let mgr = modelManager
        bleMeshManager.startServing(
            agentId: agentId,
            model: modelManager.selectedModel,
            modelParamSize: modelManager.selectedModelParamSize
        ) { [weak self] prompt in
            // Unplugged while the app was suspended: refuse instead of running on battery.
            guard await self?.refreshPowerState() == true else {
                return (ok: false, output: HostingPowerPolicy.notChargingReply, durationMs: 0)
            }
            return await mgr.generate(prompt: prompt, maxTokens: 512)
        }
    }

    /// Called after enrollment is confirmed. Auto-starts hosting if enabled.
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

    /// Starts hosting: the register/heartbeat/job loop, which pulls coordinator jobs only while
    /// charging, Bluetooth scanning, and Bluetooth serving while charging.
    func start() async {
        if state == .running {
            statusText = "Hosting is already running."
            return
        }
        // Model activation is handled separately via LocalModelManager.activate(modelId:)
        persistRuntimeSettings()
        appendEvent("Starting hosting → coordinator: \(selectedCoordinatorURL), token: \(registrationToken.isEmpty ? "empty" : "present"), meshToken: \(meshToken.isEmpty ? "empty" : "present")")
        runtimeTask?.cancel()
        runtimeTask = Task { [weak self] in
            await self?.runtimeLoop()
        }
        state = .running
        statusText = "Hosting with local model \(modelManager.selectedModel)."
        appendEvent(statusText)
        await discoverCoordinators()
        bleMeshManager.start()
        // #63: the agent key signs this device's side of BLE credit transactions.
        bleMeshManager.signingKey = resolveSigningKey()
        bleMeshManager.startScanning()
        // Serve nearby machines only while charging; the battery observer starts and stops it later.
        isCharging = isOnExternalPower
        applyBluetoothServing()
        if !isCharging { appendEvent("On battery: network jobs and Bluetooth serving wait for charging.") }
    }

    /// Pauses the coordinator loop (no jobs, no heartbeats); Bluetooth serving keeps following the
    /// charging state.
    func pause() {
        runtimeTask?.cancel()
        runtimeTask = nil
        state = .paused
        statusText = isCharging ? "Network jobs paused; Bluetooth still serving." : "Network jobs paused."
        appendEvent(statusText)
    }

    func stop() {
        runtimeTask?.cancel()
        runtimeTask = nil
        bleMeshManager.stop()
        state = .stopped
        statusText = "Hosting stopped."
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
        isRegistered = false
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
        return HostingPowerPolicy.mayHost(UIDevice.current.batteryState)
    }

    /// The persistent Keychain signing key (#64). If the Keychain is unavailable the runtime falls
    /// back to an in-memory key for this process so registration and signing still agree.
    private func resolveSigningKey() -> Curve25519.Signing.PrivateKey {
        if let key = signingKey { return key }
        let key: Curve25519.Signing.PrivateKey
        do {
            key = try KeychainEd25519.loadOrCreate()
        } catch {
            key = Curve25519.Signing.PrivateKey()
            appendEvent("Keychain signing key unavailable (\(error.localizedDescription)); using an in-memory key until restart.")
        }
        signingKey = key
        return key
    }

    /// SPKI PEM of the signing key, exactly as the coordinator stores it from /register.
    var signingPublicKeyPem: String {
        Ed25519PEM.publicKeyPEM(resolveSigningKey().publicKey)
    }

    func persistRuntimeSettings() {
        UserDefaults.standard.set(agentId, forKey: DefaultsKey.agentId)
        RuntimeSecretStore.save(registrationToken, for: DefaultsKey.registrationToken)
        RuntimeSecretStore.save(meshToken, for: DefaultsKey.meshToken)
        UserDefaults.standard.set(selectedCoordinatorURL, forKey: DefaultsKey.coordinatorURL)
        UserDefaults.standard.set(diagnosticsUploadEnabled, forKey: DefaultsKey.diagnosticsUploadEnabled)
        UserDefaults.standard.set(autoStartEnabled, forKey: DefaultsKey.autoStartEnabled)
        UserDefaults.standard.set(coordinatorTasksObserved, forKey: DefaultsKey.coordinatorTasksObserved)
        UserDefaults.standard.set(tasksCompleted, forKey: DefaultsKey.tasksCompleted)
        UserDefaults.standard.set(tasksFailed, forKey: DefaultsKey.tasksFailed)
        UserDefaults.standard.set(creditsEarned, forKey: DefaultsKey.creditsEarned)
    }

    /// Register, heartbeat every ~15 s, and between heartbeats poll for a coordinator job every 5 s,
    /// but only while charging. Registration and heartbeats run on battery too: Bluetooth needs the
    /// reward account from /register and the heartbeat's offline/online signal (BLE scanning, offline
    /// ledger sync).
    private func runtimeLoop() async {
        while !Task.isCancelled {
            let registered = await registerAgent()
            if registered {
                await sendHeartbeat()
                // Poll for tasks between heartbeats (3 polls per 15s cycle), only while charging.
                for _ in 0..<3 {
                    guard !Task.isCancelled else { break }
                    if isCharging { await pollAndExecuteTask() }
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                }
            } else {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func registerAgent() async -> Bool {
        if isSwarmReady { return true }
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
            "powerTelemetry": currentPowerTelemetry(),
            // #64: the key RequestSigner signs with; the coordinator verifies /heartbeat, /pull,
            // /result and /credits/ble-sync against it.
            "publicKeyPem": signingPublicKeyPem
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
            // #63: BLE credit transactions sign the reward account the coordinator resolves for us.
            if let rewardAccountId = response["rewardAccountId"] as? String, !rewardAccountId.isEmpty,
               !rewardAccountId.utf8.contains(0x0A) {
                bleMeshManager.currentAccountId = rewardAccountId
            }
            isRegistered = true
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
                isRegistered = false
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
                isRegistered = false
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
        // Coordinator jobs run only on external power; the coordinator refuses them otherwise too.
        guard isOnExternalPower else { return }
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
            // #63: drop only what settled (or can never settle); the rest is retried later.
            let syncedIds = OfflineLedger.settledTxIds(fromSyncResponse: response)
            ledger.markSynced(syncedIds)
            let applied = (response["applied"] as? [String])?.count ?? 0
            appendEvent("Offline ledger sync complete — \(applied) applied, \(syncedIds.count) settled, \(pending.count - syncedIds.count) still pending.")
        } catch {
            appendEvent("Offline ledger sync failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Chat Task Submission (used by ChatRouter)

    /// Run a chat on the network as a model call (SwarmChatProtocol): POST /inference/submit, then read
    /// the reply from /inference/stream until it ends. Billed to this agent's owner like any network
    /// call; coordinator refusals (insufficient_credits, no_agent_has_model, no_capacity, ...) throw.
    func submitChatTask(
        messages: [SwarmChatProtocol.Message],
        requestedModel: String? = nil
    ) async throws -> (output: String, taskId: String, creditsSpent: Double?) {
        let taskId = SwarmChatProtocol.newTaskId()
        let submitResponse = try await postCoordinator(
            path: SwarmChatProtocol.submitPath,
            payload: SwarmChatProtocol.submitBody(taskId: taskId, agentId: agentId, messages: messages, requestedModel: requestedModel)
        )
        guard let subtaskId = SwarmChatProtocol.subtaskId(fromSubmit: submitResponse) else {
            throw APIClientError.serverError("Network chat: the coordinator returned no subtask.")
        }

        var output = ""
        var after = 0
        var transientFailures = 0
        let deadline = Date().addingTimeInterval(SwarmChatProtocol.deadlineSeconds)
        while Date() < deadline {
            try Task.checkCancellation()
            let response: [String: Any]
            do {
                response = try await postCoordinator(
                    path: SwarmChatProtocol.streamPath,
                    payload: SwarmChatProtocol.streamBody(taskId: taskId, subtaskId: subtaskId, after: after)
                )
            } catch let error as URLError {
                // A dropped connection: read again from the same place, a few times.
                transientFailures += 1
                if transientFailures > 3 { throw error }
                try await Task.sleep(nanoseconds: 1_000_000_000)
                continue
            }
            transientFailures = 0
            guard let page = SwarmChatProtocol.streamPage(response, after: after) else {
                throw APIClientError.serverError("Network chat: unexpected stream answer.")
            }
            output += page.text
            after = page.next
            if page.done {
                if let error = page.error { throw APIClientError.serverError("Network chat failed: \(error)") }
                return (output: output, taskId: taskId, creditsSpent: page.creditsSpent)
            }
        }
        throw APIClientError.serverError("Network chat timed out after \(Int(SwarmChatProtocol.deadlineSeconds))s")
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
        // #64: sign the exact bytes that go on the wire (never a re-encoded copy) with the
        // Keychain Ed25519 key; `path` is the route path the coordinator verifies against.
        let bodyData = try JSONSerialization.data(withJSONObject: payload)
        request.httpBody = bodyData
        let signed = try RequestSigner.sign(
            method: "POST",
            path: path,
            body: bodyData,
            agentId: agentId,
            privateKey: resolveSigningKey()
        )
        signed.apply(to: &request)
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
        guard isSwarmReady else { return }
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

/// The registration and mesh tokens are bearer secrets: they live in the Keychain
/// (AfterFirstUnlockThisDeviceOnly, so background heartbeats can read them and backups never carry
/// them), not in UserDefaults. A value an older build left in UserDefaults is moved on first read.
private enum RuntimeSecretStore {
    private static let service = "io.edgecoder.ios.runtime-tokens"

    static func load(_ key: String) -> String {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            UserDefaults.standard.removeObject(forKey: key)
            return value
        }
        let legacy = UserDefaults.standard.string(forKey: key) ?? ""
        if !legacy.isEmpty { save(legacy, for: key) }
        return legacy
    }

    /// Stores `value` (an empty value deletes it); the UserDefaults copy is removed once the Keychain has it.
    static func save(_ value: String, for key: String) {
        guard !value.isEmpty else {
            SecItemDelete(baseQuery(key) as CFDictionary)
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        let data = Data(value.utf8)
        var add = baseQuery(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(baseQuery(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        if status == errSecSuccess { UserDefaults.standard.removeObject(forKey: key) }
    }

    private static func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}
