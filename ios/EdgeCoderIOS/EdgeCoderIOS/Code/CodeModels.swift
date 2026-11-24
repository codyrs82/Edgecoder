import Foundation

// Code mode: coding sessions on the user's own computers, driven through the portal.
//
//   GET  /portal/api/code/machines                  -> CodeMachinesResponse
//   POST /portal/api/code/{agentId}/commands        { action, ...args } -> 202 { commandId }
//   GET  /portal/api/code/commands/{commandId}      -> CodeCommandState
//
// A command's result is what the Mac's src/apps/ide/code-remote.ts answers. Every type here decodes
// leniently: unknown fields are ignored and anything the Mac or portal may leave out is optional or
// has a default, so an older or newer desktop app doesn't break the screen.

// MARK: - Lenient decoding

extension KeyedDecodingContainer {
    /// The value, or `fallback` when the key is missing, null, or of another type.
    func lenient<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }

    /// The value, or nil when the key is missing, null, or of another type.
    func lenient<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    /// A list; elements that don't decode are skipped instead of failing the whole list.
    func lenientList<T: Decodable>(_ key: Key) -> [T] {
        guard let items = (try? decodeIfPresent([LenientItem<T>].self, forKey: key)) ?? nil else { return [] }
        return items.compactMap(\.value)
    }
}

/// Decodes one list element without throwing.
struct LenientItem<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// Any JSON value (a command's result is unwrapped and re-decoded into the action's type).
enum CodeJSON: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CodeJSON])
    case object([String: CodeJSON])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([CodeJSON].self) { self = .array(a) }
        else if let o = try? c.decode([String: CodeJSON].self) { self = .object(o) }
        else { self = .null }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> CodeJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Re-decodes this value as `T`.
    func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - Machines (portal)

enum CodeControls: String, Decodable {
    /// "Code from your phone" is off on that computer.
    case off
    /// The phone may look but not drive.
    case view
    case on

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = CodeControls(rawValue: raw) ?? .off
    }
}

struct CodeMachinesResponse: Decodable {
    let machines: [CodeMachine]

    enum CodingKeys: String, CodingKey { case machines }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machines = c.lenientList(.machines)
    }
}

struct CodeMachine: Decodable, Identifiable, Equatable {
    let agentId: String
    let name: String
    let online: Bool
    let controls: CodeControls
    let projects: [CodeProject]
    let sessions: [CodeSessionSummary]
    let updatedAtMs: Double?

    var id: String { agentId }

    /// What the machine list says under its name.
    enum Availability: Equatable {
        case ready, viewOnly, off, offline
    }

    var availability: Availability {
        if !online { return .offline }
        switch controls {
        case .on: return .ready
        case .view: return .viewOnly
        case .off: return .off
        }
    }

    var canDrive: Bool { availability == .ready }
    /// Sessions can be read (snapshot, changes) from a machine that is online and not off.
    var canRead: Bool { availability == .ready || availability == .viewOnly }

    func project(_ id: String) -> CodeProject? { projects.first { $0.projectId == id } }

    enum CodingKeys: String, CodingKey { case agentId, name, online, controls, projects, sessions, updatedAtMs }

    init(agentId: String, name: String, online: Bool, controls: CodeControls, projects: [CodeProject] = [], sessions: [CodeSessionSummary] = [], updatedAtMs: Double? = nil) {
        self.agentId = agentId
        self.name = name
        self.online = online
        self.controls = controls
        self.projects = projects
        self.sessions = sessions
        self.updatedAtMs = updatedAtMs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try c.decode(String.self, forKey: .agentId)
        let n: String = c.lenient(.name, "")
        name = n.isEmpty ? "Computer" : n
        online = c.lenient(.online, false)
        controls = c.lenient(.controls, .off)
        projects = c.lenientList(.projects)
        sessions = c.lenientList(.sessions)
        updatedAtMs = c.lenient(.updatedAtMs)
    }
}

/// A folder trusted on that computer (workspace-trust.ts TrustedProject). No paths: only names.
struct CodeProject: Decodable, Identifiable, Equatable {
    let projectId: String
    let name: String
    let parent: String
    let branch: String?

    var id: String { projectId }

    enum CodingKeys: String, CodingKey { case projectId, name, parent, branch }

    init(projectId: String, name: String, parent: String = "", branch: String? = nil) {
        self.projectId = projectId
        self.name = name
        self.parent = parent
        self.branch = branch
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = try c.decode(String.self, forKey: .projectId)
        name = c.lenient(.name, "")
        parent = c.lenient(.parent, "")
        branch = c.lenient(.branch)
    }
}

enum CodeSessionStatus: String, Decodable {
    case idle, running, waiting

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = CodeSessionStatus(rawValue: raw) ?? .idle
    }

    var label: String {
        switch self {
        case .idle: return "Idle"
        case .running: return "Running"
        case .waiting: return "Waiting for you"
        }
    }

    /// Running or waiting: the session view keeps refreshing.
    var isActive: Bool { self != .idle }
}

/// One session in the portal's machine list.
struct CodeSessionSummary: Decodable, Identifiable, Equatable {
    let sessionId: String
    let projectId: String
    let title: String
    let status: CodeSessionStatus
    let updatedAtMs: Double
    let pendingApprovals: Int
    /// "phone" or "mac".
    let startedFrom: String

    var id: String { sessionId }
    var updatedAt: Date { Date(timeIntervalSince1970: updatedAtMs / 1000) }

    enum CodingKeys: String, CodingKey { case sessionId, projectId, title, status, updatedAtMs, pendingApprovals, startedFrom }

    init(sessionId: String, projectId: String, title: String, status: CodeSessionStatus = .idle, updatedAtMs: Double = 0, pendingApprovals: Int = 0, startedFrom: String = "phone") {
        self.sessionId = sessionId
        self.projectId = projectId
        self.title = title
        self.status = status
        self.updatedAtMs = updatedAtMs
        self.pendingApprovals = pendingApprovals
        self.startedFrom = startedFrom
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        projectId = c.lenient(.projectId, "")
        let t: String = c.lenient(.title, "")
        title = t.isEmpty ? "Untitled session" : t
        status = c.lenient(.status, .idle)
        updatedAtMs = c.lenient(.updatedAtMs, 0)
        pendingApprovals = c.lenient(.pendingApprovals, 0)
        startedFrom = c.lenient(.startedFrom, "mac")
    }

    /// "Running · 1 approval waiting".
    var statusLine: String {
        var parts = [status.label]
        if pendingApprovals > 0 { parts.append(pendingApprovals == 1 ? "1 approval waiting" : "\(pendingApprovals) approvals waiting") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Session modes

/// The permission modes the phone may pick. "auto" is set on the Mac only (code-remote.ts refuses it).
enum CodeMode: String, CaseIterable, Identifiable {
    case ask
    case autoEdits = "auto-edits"
    case plan

    var id: String { rawValue }

    var label: String {
        switch self {
        case .ask: return "Ask"
        case .autoEdits: return "Accept edits"
        case .plan: return "Plan"
        }
    }

    var explanation: String {
        switch self {
        case .ask: return "Asks before every edit and command."
        case .autoEdits: return "Edits files without asking; still asks before commands."
        case .plan: return "Writes a plan first; nothing changes until you approve it."
        }
    }

    /// The label for any mode the Mac reports, including "auto".
    static func label(for raw: String) -> String {
        if raw == "auto" { return "Auto (set on the Mac)" }
        return CodeMode(rawValue: raw)?.label ?? raw.capitalized
    }
}

// MARK: - Snapshot (code-remote.ts RemoteSessionSnapshot)

struct CodeToolStep: Decodable, Equatable {
    let tool: String
    let detail: String
    /// ok | error | pending | denied | running
    let status: String
    /// Ran in the Mac's OS sandbox (Auto mode): project-only writes, no network.
    let sandboxed: Bool

    enum CodingKeys: String, CodingKey { case tool, detail, status, sandboxed }
    init(tool: String, detail: String, status: String, sandboxed: Bool = false) {
        self.tool = tool
        self.detail = detail
        self.status = status
        self.sandboxed = sandboxed
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = c.lenient(.tool, "tool")
        detail = c.lenient(.detail, "")
        status = c.lenient(.status, "ok")
        sandboxed = (try? c.decodeIfPresent(Bool.self, forKey: .sandboxed)) == true
    }
}

struct CodeMessage: Decodable, Identifiable, Equatable {
    let id: String
    /// user | assistant | note
    let role: String
    let content: String
    let at: Double
    let by: String?
    let turnId: String?
    let changedFiles: [String]
    let undone: Bool
    let plan: Bool
    let steps: [CodeToolStep]

    enum CodingKeys: String, CodingKey { case id, role, content, at, by, turnId, changedFiles, undone, plan, steps }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, UUID().uuidString)
        role = c.lenient(.role, "note")
        content = c.lenient(.content, "")
        at = c.lenient(.at, 0)
        by = c.lenient(.by)
        turnId = c.lenient(.turnId)
        changedFiles = c.lenient(.changedFiles, [])
        undone = c.lenient(.undone, false)
        plan = c.lenient(.plan, false)
        steps = c.lenientList(.steps)
    }
}

struct CodeApproval: Decodable, Identifiable, Equatable {
    let callId: String
    let tool: String
    /// One line: the file, the commit message.
    let detail: String
    /// run_shell: the whole command.
    let command: String?
    /// False: shown, but it must be approved on the Mac.
    let approvable: Bool
    let message: String?

    var id: String { callId }

    enum CodingKeys: String, CodingKey { case callId, tool, detail, command, approvable, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callId = try c.decode(String.self, forKey: .callId)
        tool = c.lenient(.tool, "tool")
        detail = c.lenient(.detail, "")
        command = c.lenient(.command)
        approvable = c.lenient(.approvable, false)
        message = c.lenient(.message)
    }

    /// The text the card shows in full: the command for run_shell, the detail otherwise.
    var fullText: String {
        if let command, !command.isEmpty { return command }
        return detail
    }
}

struct CodeQueuedMessage: Decodable, Identifiable, Equatable {
    let id: String
    let text: String
    let by: String?
    let label: String?

    enum CodingKeys: String, CodingKey { case id, text, by, label }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = c.lenient(.text, "")
        by = c.lenient(.by)
        label = c.lenient(.label)
    }
}

/// The session header in a snapshot (code-remote.ts RemoteSessionSummary).
struct CodeSessionInfo: Decodable, Equatable {
    let id: String
    let title: String
    let projectId: String
    let projectName: String
    let branch: String?
    let model: String
    /// ask | auto-edits | plan | auto
    let mode: String
    let origin: String?
    let running: Bool
    let pending: Int
    let queued: Int
    let cSats: Double
    let updatedAt: Double

    enum CodingKeys: String, CodingKey { case id, title, projectId, projectName, branch, model, mode, origin, running, pending, queued, cSats, updatedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(.id, "")
        let t: String = c.lenient(.title, "")
        title = t.isEmpty ? "Untitled session" : t
        projectId = c.lenient(.projectId, "")
        projectName = c.lenient(.projectName, "")
        branch = c.lenient(.branch)
        model = c.lenient(.model, "")
        mode = c.lenient(.mode, "ask")
        origin = c.lenient(.origin)
        running = c.lenient(.running, false)
        pending = c.lenient(.pending, 0)
        queued = c.lenient(.queued, 0)
        cSats = c.lenient(.cSats, 0)
        updatedAt = c.lenient(.updatedAt, 0)
    }
}

struct CodeRunningTurn: Decodable, Equatable {
    let turnId: String
    let text: String
    let steps: [CodeToolStep]

    enum CodingKeys: String, CodingKey { case turnId, text, steps }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turnId = c.lenient(.turnId, "")
        text = c.lenient(.text, "")
        steps = c.lenientList(.steps)
    }
}

/// The `snapshot` action's result: the session, its transcript tail, what's running and waiting.
struct CodeSessionSnapshot: Decodable, Equatable {
    let session: CodeSessionInfo
    let seq: Int
    let running: CodeRunningTurn?
    let pending: [CodeApproval]
    let queue: [CodeQueuedMessage]
    let tail: [CodeMessage]

    enum CodingKeys: String, CodingKey { case session, seq, running, pending, queue, tail }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(CodeSessionInfo.self, forKey: .session)
        seq = c.lenient(.seq, 0)
        running = c.lenient(.running)
        pending = c.lenientList(.pending)
        queue = c.lenientList(.queue)
        tail = c.lenientList(.tail)
    }

    var status: CodeSessionStatus {
        if !pending.isEmpty { return .waiting }
        if running != nil || session.running { return .running }
        return .idle
    }

    /// The newest turn that wasn't undone ("Undo last turn").
    var lastTurnId: String? {
        tail.last { $0.turnId != nil && !$0.undone && $0.role == "assistant" }?.turnId
            ?? tail.last { $0.turnId != nil && !$0.undone }?.turnId
    }

    /// Plan mode and the last reply is a plan: the phone can approve it.
    var awaitingPlanApproval: Bool {
        status == .idle && session.mode == "plan" && tail.last(where: { $0.role == "assistant" })?.plan == true
    }
}

// MARK: - Changes (code-remote.ts "changes")

struct CodeFileChange: Decodable, Identifiable, Equatable {
    let path: String
    /// nil: the file was created.
    let before: String?
    /// nil: the file was deleted.
    let after: String?
    /// The file was longer than the Mac sends; the diff covers its start.
    let cut: Bool

    var id: String { path }

    enum CodingKeys: String, CodingKey { case path, before, after, cut }
    init(path: String, before: String?, after: String?, cut: Bool = false) {
        self.path = path
        self.before = before
        self.after = after
        self.cut = cut
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = c.lenient(.path, "file")
        before = c.lenient(.before)
        after = c.lenient(.after)
        cut = c.lenient(.cut, false)
    }

    var kind: String {
        if before == nil { return "Added" }
        if after == nil { return "Deleted" }
        return "Modified"
    }
}

struct CodeChanges: Decodable, Equatable {
    let items: [CodeFileChange]
    let total: Int
    let truncated: Bool

    enum CodingKeys: String, CodingKey { case items, total, truncated }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.lenientList(.items)
        total = c.lenient(.total, items.count)
        truncated = c.lenient(.truncated, false)
    }
}

/// `messages`: an older page of the transcript.
struct CodeMessagesPage: Decodable {
    let items: [CodeMessage]
    let more: Bool

    enum CodingKeys: String, CodingKey { case items, more }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.lenientList(.items)
        more = c.lenient(.more, false)
    }
}

/// `create`: the new session.
struct CodeCreated: Decodable {
    let sessionId: String
}

// MARK: - Commands (portal)

struct CodeCommandAccepted: Decodable {
    let commandId: String?
    let error: String?
    let message: String?
}

/// GET /portal/api/code/commands/{id}.
struct CodeCommandState: Decodable {
    /// pending | done | failed | expired
    let status: String
    let result: CodeJSON?
    let error: String?
    let message: String?

    enum CodingKeys: String, CodingKey { case status, result, error, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(.status, "pending")
        result = c.lenient(.result)
        error = c.lenient(.error)
        message = c.lenient(.message)
    }

    init(status: String, result: CodeJSON? = nil, error: String? = nil, message: String? = nil) {
        self.status = status
        self.result = result
        self.error = error
        self.message = message
    }

    var isFinished: Bool { status != "pending" }

    /// The command's data, or the error it ended with. The Mac answers { status, error?, message?,
    /// data? } (CodeRemoteOutcome); a portal that passes only `data` through is read the same way.
    func outcome() -> Result<CodeJSON, CodeError> {
        switch status {
        case "pending":
            return .failure(.timedOut)
        case "expired":
            return .failure(.expired)
        case "failed":
            return .failure(CodeError.from(code: error ?? result?["error"]?.string, message: message ?? result?["message"]?.string))
        default:
            break
        }
        guard let result else { return .success(.object([:])) }
        if case .object(let o) = result, let s = o["status"]?.string, ["done", "refused", "failed"].contains(s) {
            if s != "done" { return .failure(CodeError.from(code: o["error"]?.string, message: o["message"]?.string)) }
            return .success(o["data"] ?? .object([:]))
        }
        return .success(result)
    }
}

// MARK: - Errors in plain sentences

enum CodeError: Error, Equatable, LocalizedError {
    case signedOut
    case notYourMachine
    case offline
    case relayOff
    case viewOnly
    case rateLimited
    case badRequest(String?)
    case timedOut
    case expired
    /// The Mac refused (no such session, auto mode is set on the Mac, ...): its own sentence.
    case refused(code: String?, message: String?)
    case network(String)
    case unreadable
    /// One of the above with the portal's or Mac's own `message`, which is shown instead.
    indirect case described(CodeError, String)

    /// A portal or Mac error code (and any message it sent), with the HTTP status as a fallback.
    /// A `message` is preferred over the app's own sentence when present, except for relay_off
    /// (a coordinator that just restarted says relay_off for a Mac that is on; the app's wording
    /// covers both).
    static func from(code: String?, message: String?, status: Int? = nil) -> CodeError {
        let kind = baseKind(code: code, message: message, status: status)
        switch kind {
        case .relayOff, .badRequest, .refused:
            return kind
        default:
            if let message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .described(kind, message) }
            return kind
        }
    }

    private static func baseKind(code: String?, message: String?, status: Int?) -> CodeError {
        switch code {
        case "not_your_machine": return .notYourMachine
        case "agent_not_connected", "agent_offline", "offline": return .offline
        case "relay_off": return .relayOff
        case "view_only": return .viewOnly
        case "rate_limited": return .rateLimited
        case "unauthorized", "not_signed_in": return .signedOut
        case "unknown_command", "expired": return .expired
        default: break
        }
        switch status {
        case 401: return .signedOut
        case 403: return .notYourMachine
        case 404: return .expired
        case 409: return .offline
        case 429: return .rateLimited
        case 400: return .badRequest(message)
        default: break
        }
        return .refused(code: code, message: message)
    }

    /// The error without any server message attached.
    var kind: CodeError {
        if case .described(let k, _) = self { return k.kind }
        return self
    }

    var errorDescription: String? { sentence }

    var sentence: String {
        switch self {
        case .signedOut:
            return "You're signed out. Sign in again to reach your computers."
        case .notYourMachine:
            return "That computer belongs to another account."
        case .offline:
            return "That computer is offline. Open the EdgeCoder desktop app on it and try again."
        case .relayOff:
            return "Code from your phone looks off on this computer, or it just reconnected. Try again in a minute, or turn on 'Code from your phone' in the EdgeCoder desktop app."
        case .viewOnly:
            return "That computer is set to View only, so sessions can be read but not driven from here. \(CodeMachineCopy.turnOnHint)"
        case .rateLimited:
            return "Too many requests in a short time. Wait a few seconds and try again."
        case .badRequest(let m):
            return m.map { "The request wasn't accepted: \($0)" } ?? "The request wasn't accepted."
        case .timedOut:
            return "Your computer didn't answer in time. It may be busy or asleep; try again."
        case .expired:
            return "That command expired before your computer answered. Try again."
        case .refused(let code, let message):
            if let message, !message.isEmpty { return message }
            switch code {
            case "no_such_session": return "That session isn't on your computer anymore."
            case "no_such_project": return "That project isn't trusted on your computer anymore."
            case "no_pending_approval": return "That approval was already answered or the turn ended."
            case "approve_on_mac": return "This command is too long to check on the phone. Approve it on the Mac."
            case "auto_on_mac": return "Auto mode is turned on from the Mac."
            case "checkpoint_gone": return "That turn's changes are gone (the desktop app restarted)."
            case "no_such_turn": return "That turn isn't in this session."
            case "provider_unreachable": return "The EdgeCoder desktop app on that computer isn't answering. Make sure it's open and try again."
            case "result_too_large": return "That answer was too large to send to the phone. Look at it on the computer."
            case "not_this_account": return "The account signed in on that computer isn't this one."
            case "invalid_request", "malformed": return "Your computer didn't accept that request. Update the EdgeCoder app and the desktop app."
            default: return "Your computer couldn't do that."
            }
        case .network(let m):
            return "Couldn't reach EdgeCoder: \(m)"
        case .unreadable:
            return "The answer from your computer couldn't be read. Update the EdgeCoder desktop app."
        case .described(_, let message):
            return message
        }
    }
}

/// What the machine list says about a computer that can't be driven.
enum CodeMachineCopy {
    static let turnOnHint = "Turn on 'Code from your phone' in the EdgeCoder desktop app."

    static func status(_ m: CodeMachine) -> String {
        switch m.availability {
        case .ready: return "Online"
        case .viewOnly: return "View only"
        case .off: return "Off"
        case .offline: return "Offline"
        }
    }

    static func hint(_ m: CodeMachine) -> String? {
        switch m.availability {
        case .ready: return nil
        case .viewOnly: return "You can read sessions but not drive them. \(turnOnHint)"
        case .off: return turnOnHint
        case .offline: return "Open the EdgeCoder desktop app on this computer to reach it."
        }
    }
}
