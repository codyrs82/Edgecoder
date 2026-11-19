import Foundation

/// GET /portal/api/machines (src/portal/routes/machines.ts): the signed-in account's enrolled machines,
/// the same list as the web's Settings → Nodes → "Your machines' models". Only the fields the app
/// shows are decoded; everything is optional where an older machine may not report it.
struct MachinesListResponse: Decodable {
    let machines: [PortalMachine]
}

struct PortalMachine: Decodable, Equatable {
    let agentId: String
    let connected: Bool?
    let state: PortalMachineState?
    let stateAtMs: Double?
    let lastSeenMs: Double?
    /// Newer coordinators: the models a `compute: { target: "mine" }` chat can run here, shared on
    /// the network and kept for you only (too big to share).
    var networkModels: [String]? = nil
    var ownerModels: [String]? = nil
}

/// The machine's own report (agent-supplied).
struct PortalMachineState: Decodable, Equatable {
    let activeModel: String?
    let reportedAtMs: Double?
    let remoteControl: String?
    /// The Ollama models on the machine (older coordinators send no networkModels / ownerModels).
    var installed: [Installed]? = nil

    struct Installed: Decodable, Equatable {
        let name: String
    }
}

/// One row on the Machines tab.
struct MachineRow: Equatable, Identifiable {
    var id: String { agentId }
    let agentId: String
    let name: String
    let online: Bool
    /// Last time the network heard from it (ms since 1970); nil when never.
    let lastSeenMs: Double?
    let model: String?
    /// nil when the bots list wasn't available.
    let botCount: Int?
}

enum MachinesDirectory {
    /// The machines list, named and counted from the bots list (GET /portal/api/bots) when it has
    /// them: online first, then by name.
    static func rows(machines: MachinesListResponse, bots: BotsListResponse?) -> [MachineRow] {
        var names: [String: String] = [:]
        for t in bots?.targets ?? [] { names[t.agentId] = t.machineName }
        for m in bots?.machines ?? [] { names[m.agentId] = m.machineName }
        let botMachines = Dictionary((bots?.machines ?? []).map { ($0.agentId, $0) }, uniquingKeysWith: { a, _ in a })
        var counts: [String: Int] = [:]
        for b in bots?.bots ?? [] { if let a = b.machine?.agentId { counts[a, default: 0] += 1 } }

        let rows = machines.machines.map { m -> MachineRow in
            let name = names[m.agentId].flatMap { $0.isEmpty ? nil : $0 } ?? m.agentId
            let online = (m.connected ?? false) || (botMachines[m.agentId]?.online ?? false)
            let seen = [m.lastSeenMs, m.stateAtMs, m.state?.reportedAtMs, botMachines[m.agentId]?.reportedAtMs].compactMap { $0 }.max()
            let model = m.state?.activeModel.flatMap { $0.isEmpty ? nil : $0 }
            return MachineRow(agentId: m.agentId, name: name, online: online, lastSeenMs: seen, model: model,
                              botCount: bots == nil ? nil : counts[m.agentId, default: 0])
        }
        return rows.sorted { ($0.online ? 0 : 1, $0.name.lowercased()) < ($1.online ? 0 : 1, $1.name.lowercased()) }
    }

    static let emptyMessage = "No machines yet. Add one from the EdgeCoder desktop app or a Linux/GPU server — see edgecoder.io/docs"

    /// "Online", or "Offline · last seen 5 min ago" / "Offline · never seen".
    static func status(_ row: MachineRow, now: Date = Date()) -> String {
        if row.online { return "Online" }
        guard let ms = row.lastSeenMs, ms > 0 else { return "Offline · never seen" }
        return "Offline · last seen \(ago(ms: ms, now: now))"
    }

    /// "just now", "5 min ago", "3 h ago", "2 days ago".
    static func ago(ms: Double, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince1970 - ms / 1000)
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60)) min ago" }
        if s < 86_400 { return "\(Int(s / 3600)) h ago" }
        let d = Int(s / 86_400)
        return d == 1 ? "1 day ago" : "\(d) days ago"
    }

    static func botsLabel(_ n: Int) -> String { n == 1 ? "1 bot" : "\(n) bots" }
}
