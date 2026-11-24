import Combine
import Foundation

/// Where Code mode's data comes from: the portal, or (Debug, `-codeFixture`) canned answers.
protocol CodeBackend {
    func machines() async throws -> [CodeMachine]
    /// Sends one command to a computer and waits for its result (the Mac's `data`).
    func run(agentId: String, action: String, args: [String: CodeJSON]) async throws -> CodeJSON
}

/// Code mode's calls: the machine list, and each code-remote.ts action as a typed call.
struct CodeAPI {
    let backend: CodeBackend

    static var shared: CodeAPI {
        if CodeFixture.isEnabled { return CodeAPI(backend: CodeFixtureBackend.shared) }
        return CodeAPI(backend: PortalCodeBackend())
    }

    func machines() async throws -> [CodeMachine] {
        try await backend.machines()
    }

    func snapshot(agentId: String, sessionId: String) async throws -> CodeSessionSnapshot {
        try await run(agentId, "snapshot", ["sessionId": .string(sessionId)], as: CodeSessionSnapshot.self)
    }

    func changes(agentId: String, sessionId: String, turnId: String) async throws -> CodeChanges {
        try await run(agentId, "changes", ["sessionId": .string(sessionId), "turnId": .string(turnId)], as: CodeChanges.self)
    }

    func messages(agentId: String, sessionId: String, beforeId: String?) async throws -> CodeMessagesPage {
        var args: [String: CodeJSON] = ["sessionId": .string(sessionId)]
        if let beforeId { args["beforeId"] = .string(beforeId) }
        return try await run(agentId, "messages", args, as: CodeMessagesPage.self)
    }

    func create(agentId: String, projectId: String, title: String?, mode: CodeMode) async throws -> String {
        var args: [String: CodeJSON] = ["projectId": .string(projectId), "mode": .string(mode.rawValue)]
        if let title, !title.isEmpty { args["title"] = .string(String(title.prefix(120))) }
        return try await run(agentId, "create", args, as: CodeCreated.self).sessionId
    }

    func send(agentId: String, sessionId: String, text: String) async throws {
        _ = try await backend.run(agentId: agentId, action: "message", args: ["sessionId": .string(sessionId), "text": .string(text)])
    }

    /// `forSession`: "Allow for this session" (newer Macs): later calls of the same kind run without
    /// asking until the session ends. A plain answer sends no scope.
    func approve(agentId: String, sessionId: String, callId: String, approved: Bool, forSession: Bool = false) async throws {
        var args: [String: CodeJSON] = ["sessionId": .string(sessionId), "callId": .string(callId), "approved": .bool(approved)]
        if approved && forSession { args["scope"] = .string("session") }
        _ = try await backend.run(agentId: agentId, action: "approve", args: args)
    }

    func cancel(agentId: String, sessionId: String) async throws {
        _ = try await backend.run(agentId: agentId, action: "cancel", args: ["sessionId": .string(sessionId)])
    }

    func undo(agentId: String, sessionId: String, turnId: String?) async throws {
        var args: [String: CodeJSON] = ["sessionId": .string(sessionId)]
        if let turnId { args["turnId"] = .string(turnId) }
        _ = try await backend.run(agentId: agentId, action: "undo", args: args)
    }

    /// Approves a plan and carries on in `mode` (Ask or Accept edits).
    func approvePlan(agentId: String, sessionId: String, mode: CodeMode) async throws {
        _ = try await backend.run(agentId: agentId, action: "plan", args: ["sessionId": .string(sessionId), "mode": .string(mode == .autoEdits ? "auto-edits" : "ask")])
    }

    /// Full access goes through only with `confirmFull` (after the confirm alert); the Mac refuses
    /// it otherwise ("confirm_full").
    func setMode(agentId: String, sessionId: String, mode: CodeMode, confirmFull: Bool = false) async throws {
        var args: [String: CodeJSON] = ["sessionId": .string(sessionId), "mode": .string(mode.rawValue)]
        if mode == .full && confirmFull { args["confirmFull"] = .bool(true) }
        _ = try await backend.run(agentId: agentId, action: "settings", args: args)
    }

    func unqueue(agentId: String, sessionId: String, queuedId: String) async throws {
        _ = try await backend.run(agentId: agentId, action: "unqueue", args: ["sessionId": .string(sessionId), "queuedId": .string(queuedId)])
    }

    private func run<T: Decodable>(_ agentId: String, _ action: String, _ args: [String: CodeJSON], as: T.Type) async throws -> T {
        let data = try await backend.run(agentId: agentId, action: action, args: args)
        do {
            return try data.decode(T.self)
        } catch {
            throw CodeError.unreadable
        }
    }
}

/// The portal: POST a command, then poll its result every ~0.7 s for up to ~30 s.
struct PortalCodeBackend: CodeBackend {
    var portal: URL = APIClient.shared.config.portalBaseURL
    var pollInterval: UInt64 = 700_000_000
    var maxWait: TimeInterval = 30

    func machines() async throws -> [CodeMachine] {
        let r = try await raw("/portal/api/code/machines")
        guard (200...299).contains(r.status) else { throw Self.error(status: r.status, data: r.data) }
        guard let decoded = try? JSONDecoder().decode(CodeMachinesResponse.self, from: r.data) else { throw CodeError.unreadable }
        return decoded.machines
    }

    func run(agentId: String, action: String, args: [String: CodeJSON]) async throws -> CodeJSON {
        var body = args
        body["action"] = .string(action)
        let agent = agentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? agentId
        let r = try await raw("/portal/api/code/\(agent)/commands", method: "POST", body: CodeJSON.object(body))
        guard (200...299).contains(r.status) else { throw Self.error(status: r.status, data: r.data) }
        // A portal may answer at once with the finished state; otherwise it hands back a command id.
        if let inline = try? JSONDecoder().decode(CodeCommandState.self, from: r.data), inline.isFinished, inline.result != nil || inline.status != "done" {
            return try inline.outcome().get()
        }
        guard let accepted = try? JSONDecoder().decode(CodeCommandAccepted.self, from: r.data), let commandId = accepted.commandId else {
            throw CodeError.unreadable
        }
        let deadline = Date().addingTimeInterval(maxWait)
        while Date() < deadline {
            try await Task.sleep(nanoseconds: pollInterval)
            let s = try await raw("/portal/api/code/commands/\(commandId)")
            if s.status == 404 { throw CodeError.expired }
            guard (200...299).contains(s.status) else { throw Self.error(status: s.status, data: s.data) }
            guard let state = try? JSONDecoder().decode(CodeCommandState.self, from: s.data) else { throw CodeError.unreadable }
            if state.isFinished { return try state.outcome().get() }
        }
        throw CodeError.timedOut
    }

    private func raw(_ path: String, method: String = "GET", body: Encodable? = nil) async throws -> (status: Int, data: Data) {
        do {
            return try await APIClient.shared.requestRaw(baseURL: portal, path: path, method: method, body: body)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw CodeError.network(error.localizedDescription)
        }
    }

    /// A non-2xx answer as a CodeError: its `error` code first, the HTTP status otherwise.
    static func error(status: Int, data: Data) -> CodeError {
        let body = try? JSONDecoder().decode(CodeCommandAccepted.self, from: data)
        return CodeError.from(code: body?.error, message: body?.message, status: status)
    }
}

/// The machine list, shared by the Code screens and the drawer.
@MainActor
final class CodeStore: ObservableObject {
    @Published private(set) var machines: [CodeMachine] = []
    @Published private(set) var loaded = false
    @Published private(set) var loading = false
    @Published private(set) var error: String?

    let api: CodeAPI

    init(api: CodeAPI = .shared) {
        self.api = api
    }

    func machine(_ agentId: String) -> CodeMachine? {
        machines.first { $0.agentId == agentId }
    }

    private var inflight: Task<Void, Never>?

    /// Fetches the list once even when several screens ask at the same time. The fetch is not tied
    /// to the asking view's task, so a screen that goes away doesn't cancel it for the others.
    func refresh() async {
        if let inflight {
            await inflight.value
            return
        }
        let task = Task { await load() }
        inflight = task
        await task.value
        inflight = nil
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            machines = try await api.machines()
            error = nil
        } catch {
            self.error = (error as? CodeError)?.sentence ?? error.localizedDescription
        }
        loaded = true
    }

    func refreshInBackground() {
        Task { await refresh() }
    }
}
