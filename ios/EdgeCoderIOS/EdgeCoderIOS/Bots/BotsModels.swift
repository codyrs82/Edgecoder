import Foundation

/// Bots in the cloud and on the account's desktop machines, through the portal's bot relay (src/portal/routes/bots.ts,
/// src/common/bot-relay.ts). Optional where a desktop may not send a field, so an older desktop
/// degrades instead of failing to decode.
struct BotMachine: Decodable, Equatable, Identifiable {
    var id: String { agentId }
    let agentId: String
    let machineName: String
    let online: Bool
    /// "on": message, pause and approve from here; "view": read-only (approve on the machine).
    let controls: String
    let reportedAtMs: Double?

    var canControl: Bool { online && controls == "on" }
}

struct BotRun: Decodable, Equatable {
    let id: String?
    let trigger: String?
    let startedAtMs: Double?
    let endedAtMs: Double?
    let status: String?
    let summary: String?
    let cSats: Double?
    let `where`: String?
    let error: String?
}

struct BotPendingCall: Decodable, Equatable, Identifiable {
    var id: String { callId }
    let callId: String
    let tool: String
    let detail: String
    /// Newer machines: "Allow for this run" may answer it; what later calls it lets run without asking.
    let allowRun: String?

    init(callId: String, tool: String, detail: String, allowRun: String? = nil) {
        self.callId = callId
        self.tool = tool
        self.detail = detail
        self.allowRun = allowRun
    }

    enum CodingKeys: String, CodingKey { case callId, tool, detail, allowRun }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callId = try c.decode(String.self, forKey: .callId)
        tool = try c.decode(String.self, forKey: .tool)
        detail = try c.decode(String.self, forKey: .detail)
        let a = (try? c.decodeIfPresent(String.self, forKey: .allowRun)) ?? nil
        allowRun = (a?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) ? nil : a
    }

    /// The caption under "Allow for this run".
    var allowRunCaption: String? {
        allowRun.map { "Also runs \($0) without asking until this run ends." }
    }

    /// The "approve" command's args: `forRun` answers "Allow for this run" (`scope: "run"`).
    func approveArgs(approved: Bool, forRun: Bool = false) -> [String: Any] {
        var args: [String: Any] = ["callId": callId, "approved": approved]
        if approved && forRun { args["scope"] = "run" }
        return args
    }
}

struct BotToolStep: Decodable, Equatable {
    let tool: String
    let detail: String
    let status: String
}

struct BotMessage: Decodable, Equatable, Identifiable {
    let id: String
    let role: String
    let content: String
    let atMs: Double
    let steps: [BotToolStep]?
}

struct BotSummary: Decodable, Equatable, Identifiable {
    var id: String { "\(hostAgentId ?? "")/\(botId)" }
    let botId: String
    let name: String
    let role: String?
    let color: String?
    let status: String
    let activity: String?
    let enabled: Bool
    let folderName: String?
    let schedule: String?
    let runsToday: Int?
    let maxRunsPerDay: Int?
    let budgetCSatsPerDay: Double?
    let spentTodayCSats: Double?
    let held: String?
    let lastRun: BotRun?
    let pending: [BotPendingCall]?
    let queuedMessages: Int?
    /// The latest messages (only on the one-bot read).
    let tail: [BotMessage]?
    /// The machine it runs on (on the list read).
    let machine: BotMachine?
    /// "cloud" for a bot that runs in the cloud (no machine); absent on a desktop bot.
    let runtime: String?
    /// "cloud" for a cloud bot; absent on an older portal.
    let agentId: String?
    /// A cloud bot's own settings (on its detail read).
    let cloud: CloudBotSettings?

    enum CodingKeys: String, CodingKey {
        case botId = "id"
        case name, role, color, status, activity, enabled, folderName, schedule, runsToday, maxRunsPerDay
        case budgetCSatsPerDay, spentTodayCSats, held, lastRun, pending, queuedMessages, tail, machine
        case runtime, agentId, cloud
    }

    /// Runs in the cloud, not on one of your machines.
    var isCloud: Bool { runtime == "cloud" || agentId == BotTarget.cloudId || machine?.agentId == BotTarget.cloudId }
    /// Where its detail and commands live: "cloud", or the machine's agent id.
    var hostAgentId: String? { isCloud ? BotTarget.cloudId : (machine?.agentId ?? agentId) }

    /// A run is going (Stop can end it).
    var isRunning: Bool { status == "running" }

    /// Paused by its owner, or held by the desktop (a stuck loop, the budget).
    var isPaused: Bool { !enabled || status == "paused" || held != nil }
}

/// `bot.cloud` on a cloud bot's read: what it was set up with. Read loosely.
struct CloudBotSettings: Decodable, Equatable {
    struct GitHub: Decodable, Equatable {
        let repo: String?
        let hasToken: Bool?
        let available: Bool?
    }
    /// "auto", "mine:<model>" or "network:<model>".
    let compute: String?
    let web: Bool?
    let github: GitHub?

    var modelLabel: String { BotModelChoice(computeString: compute).label }
}

/// A bot made on the web (#414) that has not reached a machine yet.
struct PendingBot: Decodable, Equatable, Identifiable {
    var id: String { requestId }
    let requestId: String
    let botId: String?
    let name: String
    let state: String
    let machineName: String?
    let error: String?
    let message: String?
}

/// A machine a new bot can be sent to.
struct BotTarget: Decodable, Equatable, Identifiable, Hashable {
    var id: String { agentId }
    let agentId: String
    let machineName: String
    let online: Bool
    let canCreate: Bool?

    static let cloudId = "cloud"
    var isCloud: Bool { agentId == Self.cloudId }
}

struct BotsListResponse: Decodable {
    let machines: [BotMachine]
    let bots: [BotSummary]
    let pending: [PendingBot]?
    let targets: [BotTarget]?
    /// The portal can hold new bots for a machine (#414).
    let canCreate: Bool?
    /// Cloud bot features on this portal (absent: no cloud bots, or an older portal).
    let cloud: CloudFeatures?

    struct CloudFeatures: Decodable, Equatable {
        /// GitHub repositories and triggers can be used by cloud bots (the token store is set up).
        let github: Bool?
    }
    /// GitHub works for cloud bots here (unknown: assumed yes).
    var cloudGitHub: Bool { cloud?.github ?? true }

    /// The cloud target, when the portal runs cloud bots (nil: no cloud yet, an older portal).
    var cloudTarget: BotTarget? { (targets ?? []).first { $0.isCloud && $0.canCreate != false } }
    /// Your machines a new bot can be sent to (only when the portal can hold new bots for them).
    var machineTargets: [BotTarget] {
        guard canCreate == true else { return [] }
        return (targets ?? []).filter { !$0.isCloud && $0.canCreate != false }
    }
    /// Every place a new bot can run: the cloud first, then your machines.
    var createTargets: [BotTarget] { (cloudTarget.map { [$0] } ?? []) + machineTargets }
    /// Bots that run in the cloud.
    var cloudBots: [BotSummary] { bots.filter(\.isCloud) }
}

/// Which model a new bot uses.
enum BotModelChoice: Hashable {
    case auto
    case mine(String)
    case network(String)

    /// The portal's compute string for a bot: "auto", "mine:<model>", "network:<model>".
    var computeString: String {
        switch self {
        case .auto: return "auto"
        case .mine(let m): return "mine:\(m)"
        case .network(let m): return "network:\(m)"
        }
    }

    /// From the portal's compute string; a bare model name is a network model.
    init(computeString: String?) {
        let s = (computeString ?? "").trimmingCharacters(in: .whitespaces)
        if s.isEmpty || s == "auto" { self = .auto }
        else if s.hasPrefix("mine:") { self = .mine(String(s.dropFirst(5))) }
        else if s.hasPrefix("network:") { self = .network(String(s.dropFirst(8))) }
        else { self = .network(s) }
    }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .network("auto"): return "Network · best fit"
        case .mine(let m): return "My machines · \(m)"
        case .network(let m): return "Network · \(m)"
        }
    }
}

/// When a new bot runs on its own (besides messages and triggers).
enum BotScheduleChoice: Equatable {
    case none
    case everyHours(Int)
    /// Hour and minute in the phone's time zone; sent as UTC.
    case daily(hour: Int, minute: Int)
}

/// One GitHub event that starts a run.
enum BotGitHubTrigger: Equatable {
    case prOpened
    case ciFailed
    case issueLabeled(String)
}

/// POST /portal/api/bots/new. Fields left at their default (Auto model, web on, no schedule, no
/// GitHub) are left out, so a portal from before cloud bots still takes a plain machine bot.
struct NewBotRequest: Encodable {
    struct GitHub: Equatable {
        /// "owner/name".
        let repo: String
        /// Sent once with the request; never stored on the phone.
        let token: String?
        let triggers: [BotGitHubTrigger]
    }
    struct Spec: Encodable {
        let name: String
        let role: String
        let instructions: String
        var model: BotModelChoice = .auto
        var web: Bool = true
        var schedule: BotScheduleChoice = .none
        var github: GitHub?
        /// The time zone a daily time is read in (the phone's).
        var timeZone: TimeZone = .current
        /// The day the daily time is converted on (daylight saving).
        var now: Date = Date()

        init(name: String, role: String, instructions: String, model: BotModelChoice = .auto, web: Bool = true,
             schedule: BotScheduleChoice = .none, github: GitHub? = nil, timeZone: TimeZone = .current, now: Date = Date()) {
            self.name = name; self.role = role; self.instructions = instructions
            self.model = model; self.web = web; self.schedule = schedule; self.github = github
            self.timeZone = timeZone; self.now = now
        }

        private struct Key: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init(_ s: String) { stringValue = s }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Key.self)
            try c.encode(name, forKey: Key("name"))
            try c.encode(role, forKey: Key("role"))
            try c.encode(instructions, forKey: Key("instructions"))
            switch model {
            case .auto: break
            case .mine, .network:
                try c.encode(model.computeString, forKey: Key("compute"))
            }
            if !web { try c.encode(false, forKey: Key("web")) }
            switch schedule {
            case .none: break
            case .everyHours(let h):
                var sc = c.nestedContainer(keyedBy: Key.self, forKey: Key("schedule"))
                try sc.encode(max(BotSchedule.minEveryMinutes, h * 60), forKey: Key("everyMinutes"))
            case .daily(let hour, let minute):
                var sc = c.nestedContainer(keyedBy: Key.self, forKey: Key("schedule"))
                try sc.encode(BotSchedule.utcTime(hour: hour, minute: minute, in: timeZone, on: now), forKey: Key("dailyAtUtc"))
            }
            if let github {
                var gc = c.nestedContainer(keyedBy: Key.self, forKey: Key("github"))
                try gc.encode(github.repo, forKey: Key("repo"))
                if let token = github.token, !token.isEmpty { try gc.encode(token, forKey: Key("token")) }
                var tc = gc.nestedUnkeyedContainer(forKey: Key("triggers"))
                for t in github.triggers {
                    var one = tc.nestedContainer(keyedBy: Key.self)
                    switch t {
                    case .prOpened: try one.encode("pr_opened", forKey: Key("kind"))
                    case .ciFailed: try one.encode("ci_failed", forKey: Key("kind"))
                    case .issueLabeled(let label):
                        try one.encode("issue_labeled", forKey: Key("kind"))
                        // Empty: the portal's default label, "bot".
                        if !label.isEmpty { try one.encode(label, forKey: Key("label")) }
                    }
                }
            }
        }
    }
    /// One per "Create bot"; a retry sends the same one.
    let requestId: String
    /// "cloud", a machine's agent id, or nil: the first of your machines that can take it.
    let agentId: String?
    let bot: Spec

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId)
        if let agentId { try c.encode(agentId, forKey: .agentId) } else { try c.encodeNil(forKey: .agentId) }
        try c.encode(bot, forKey: .bot)
    }
    enum CodingKeys: String, CodingKey { case requestId, agentId, bot }
}

enum BotSchedule {
    /// The portal runs a schedule at most every 15 minutes.
    static let minEveryMinutes = 15

    /// A GitHub token the portal takes: classic, fine-grained or app (20-400 of A-Z a-z 0-9 _ . -).
    static func isPlausibleToken(_ t: String) -> Bool {
        (20...400).contains(t.count) && t.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_.-".contains($0)) }
    }

    /// "HH:MM" in UTC for a local time of day, on the given day (so daylight saving is right today).
    static func utcTime(hour: Int, minute: Int, in timeZone: TimeZone, on day: Date) -> String {
        var local = Calendar(identifier: .gregorian)
        local.timeZone = timeZone
        var parts = local.dateComponents([.year, .month, .day], from: day)
        parts.hour = hour
        parts.minute = minute
        let instant = local.date(from: parts) ?? day
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let u = utc.dateComponents([.hour, .minute], from: instant)
        return String(format: "%02d:%02d", u.hour ?? 0, u.minute ?? 0)
    }

    /// "owner/name" from what was typed: "owner/name", a github.com URL, or with ".git"; nil if not a repo.
    static func normalizeRepo(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["https://", "http://"] where s.lowercased().hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        if s.lowercased().hasPrefix("www.") { s = String(s.dropFirst(4)) }
        if s.lowercased().hasPrefix("github.com/") { s = String(s.dropFirst("github.com/".count)) }
        while s.hasSuffix("/") { s.removeLast() }
        if s.hasSuffix(".git") { s = String(s.dropLast(4)) }
        let parts = s.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        // GitHub's rules: owner is letters, digits and dashes (not first, at most 39); repo also . and _.
        let owner = parts[0], name = parts[1]
        let alnum = { (c: Character) in c.isASCII && (c.isLetter || c.isNumber) }
        guard let first = owner.first, alnum(first), owner.count <= 39, owner.allSatisfy({ alnum($0) || $0 == "-" }) else { return nil }
        guard !name.isEmpty, name.count <= 100, name.allSatisfy({ alnum($0) || "-_.".contains($0) }) else { return nil }
        return parts.joined(separator: "/")
    }
}

/// GET /portal/api/compute/options (the web chat's model picker).
struct ComputeOptionsResponse: Decodable {
    struct Option: Decodable {
        struct Compute: Decodable {
            let target: String?
            let model: String?
            let computeClass: String?
        }
        let group: String?
        let label: String?
        let detail: String?
        let compute: Compute?
    }
    let options: [Option]?

    /// Auto, then each model your machines run, then each network model (once each).
    var modelChoices: [BotModelChoice] {
        var mine: [BotModelChoice] = []
        var network: [BotModelChoice] = []
        var seen = Set<BotModelChoice>()
        for o in options ?? [] {
            guard let c = o.compute, let model = c.model, !model.isEmpty else { continue }
            let choice: BotModelChoice
            switch c.target {
            case "mine": choice = .mine(model)
            case "network": choice = .network(model)
            default: continue
            }
            guard seen.insert(choice).inserted else { continue }
            if case .mine = choice { mine.append(choice) } else { network.append(choice) }
        }
        return [.auto] + mine + network
    }
}

struct BotDetailResponse: Decodable {
    let bot: BotSummary
    /// Absent for a cloud bot.
    let machine: BotMachine?
}

/// GET …/commands/:commandId: the command's state, read loosely (desktop relay or cloud).
struct BotCommandState: Decodable {
    struct Result: Decodable {
        let status: String?
        let error: String?
        let message: String?
    }
    /// A cloud message's run (GET /portal/api/bots/cloud/commands/:messageId).
    struct Run: Decodable {
        let id: String?
        let status: String?
    }
    let status: String?
    let result: Result?
    let run: Run?

    /// The message's run has ended (or there is no run to wait for).
    var runFinished: Bool {
        guard let s = run?.status else { return false }
        return s != "queued" && s != "running"
    }

    /// Finished one way or another: stop polling.
    var isFinished: Bool {
        let done: Set<String> = ["done", "refused", "failed", "expired", "completed", "error"]
        return done.contains(result?.status ?? "") || done.contains(status ?? "")
    }
    var failed: Bool {
        let bad: Set<String> = ["refused", "failed", "expired", "error"]
        return bad.contains(result?.status ?? "") || bad.contains(status ?? "")
    }
}

struct BotCommandResponse: Decodable {
    let ok: Bool?
    let botId: String?
    let agentId: String?
    let commandId: String?
    let error: String?
    let message: String?
    /// Cloud commands answer inline: { commandId, status: "done", data? }.
    let result: BotCommandState.Result?
    /// Cloud create: true only on the first create (false or absent on a retry).
    let created: Bool?

    /// Accepted: `ok`, or (cloud) an id back without an error.
    var accepted: Bool { error == nil && (ok == true || botId != nil || commandId != nil) }
}

enum BotsFormat {
    /// Plain words for a bot command refusal from the portal or coordinator.
    static func commandError(_ code: String?, message: String? = nil) -> String {
        switch code {
        case "agent_not_connected": return "That machine isn't connected right now. Try again when it's online."
        case "not_your_machine": return "That machine isn't on this account."
        case "no_such_bot": return "That bot isn't on this machine anymore."
        case "coordinator_unreachable": return "Couldn't reach the EdgeCoder network. Try again in a moment."
        case "relay_view_only", "view_only": return "This machine is view-only from the web. Change it on the machine itself."
        case "not_authenticated": return "Your session ended. Sign in again."
        case "invalid_command", "invalid_bot": return message ?? "That wasn't accepted."
        case "too_many_pending": return "Too many new bots are waiting for a machine."
        case "github_unavailable": return "GitHub isn't set up for cloud bots yet."
        case "too_many_bots", "rate_limited": return message ?? "Too many right now. Try again later."
        case "not_supported": return "Cloud bots don't do that."
        case "cloud_bots_unavailable", "cloud_unavailable", "cloud_not_enabled": return "Cloud bots aren't available yet. Pick one of your machines."
        case "busy": return "Try again."
        case nil: return message ?? "The command didn't go through."
        default: return message ?? "The command didn't go through (\(code!))."
        }
    }

    /// A pending web-made bot's state in words.
    static func pendingState(_ p: PendingBot) -> String {
        if let e = p.error ?? p.message, !e.isEmpty, p.state == "failed" { return "Couldn't create: \(e)" }
        switch p.state {
        case "waiting": return "Waiting for \(p.machineName ?? "a machine") to come online"
        case "sent", "delivered": return "Sent to \(p.machineName ?? "your machine"); pick its folder on that machine"
        case "needs_folder": return "Pick its folder on \(p.machineName ?? "the machine")"
        case "created": return "Created"
        default: return p.state.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// "Running", "Paused", "Idle" and the like from the desktop's status word.
    static func status(_ bot: BotSummary) -> String {
        if let held = bot.held, !held.isEmpty { return "Held: \(held)" }
        if !bot.enabled { return "Paused" }
        switch bot.status {
        case "running": return bot.activity.map { "Running · \($0)" } ?? "Running"
        case "waiting_approval", "awaiting_approval": return "Waiting for approval"
        case "paused": return "Paused"
        case "error": return "Error"
        case "idle": return "Idle"
        default: return bot.status.prefix(1).uppercased() + bot.status.dropFirst().replacingOccurrences(of: "_", with: " ")
        }
    }
}
