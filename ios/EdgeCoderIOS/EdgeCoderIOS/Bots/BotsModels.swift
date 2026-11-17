import Foundation

/// Bots on the account's desktop machines, through the portal's bot relay (src/portal/routes/bots.ts,
/// src/common/bot-relay.ts). Optional where a desktop may not send a field, so an older desktop
/// degrades instead of failing to decode.
struct BotMachine: Decodable, Equatable, Identifiable {
    var id: String { agentId }
    let agentId: String
    let machineName: String
    let online: Bool
    /// "on": message, pause and approve from here; "view": read-only (approve on the Mac).
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
    var id: String { "\(machine?.agentId ?? "")/\(botId)" }
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

    enum CodingKeys: String, CodingKey {
        case botId = "id"
        case name, role, color, status, activity, enabled, folderName, schedule, runsToday, maxRunsPerDay
        case budgetCSatsPerDay, spentTodayCSats, held, lastRun, pending, queuedMessages, tail, machine
    }

    /// Paused by its owner, or held by the desktop (a stuck loop, the budget).
    var isPaused: Bool { !enabled || status == "paused" || held != nil }
}

struct BotsListResponse: Decodable {
    let machines: [BotMachine]
    let bots: [BotSummary]
}

struct BotDetailResponse: Decodable {
    let bot: BotSummary
    let machine: BotMachine
}

struct BotCommandResponse: Decodable {
    let ok: Bool?
    let commandId: String?
    let error: String?
    let message: String?
}

enum BotsFormat {
    /// Plain words for a bot command refusal from the portal or coordinator.
    static func commandError(_ code: String?, message: String? = nil) -> String {
        switch code {
        case "agent_not_connected": return "That machine isn't connected right now. Try again when it's online."
        case "not_your_machine": return "That machine isn't on this account."
        case "no_such_bot": return "That bot isn't on this machine anymore."
        case "coordinator_unreachable": return "Couldn't reach the EdgeCoder network. Try again in a moment."
        case "relay_view_only", "view_only": return "This machine is view-only from the web. Change it on the Mac."
        case "not_authenticated": return "Your session ended. Sign in again."
        case "invalid_command": return message ?? "That command wasn't accepted."
        case nil: return message ?? "The command didn't go through."
        default: return message ?? "The command didn't go through (\(code!))."
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
