import Foundation

// The Network tab: GET /portal/api/network/world (src/portal/routes/network-world.ts), the network's
// world view, drawn as the hub-and-spoke graph of the web's Settings > Network
// (src/portal/pages/settings-world.ts) and the desktop's Network page (desktop/src/lib/world-view.ts).
// Pure and Foundation-only so the unit tests compile it directly.
//
// Privacy: the portal rebuilds the answer from an allowlist and other people's machines come masked
// (an OS family and a keyed hash). The app adds its own guard: a machine not marked `mine` never keeps
// a `name`, and only your machines get a label on the graph.

// MARK: - The answer

/// What a machine is doing now: counts only, never who it is serving.
struct WorldActivity: Decodable, Equatable {
    var callsNow: Int
    var streaming: Int
    var callsPerMin: Int

    init(callsNow: Int, streaming: Int, callsPerMin: Int) {
        self.callsNow = callsNow
        self.streaming = streaming
        self.callsPerMin = callsPerMin
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callsNow = max(0, (try? c.decodeIfPresent(Int.self, forKey: .callsNow)) ?? 0)
        streaming = max(0, (try? c.decodeIfPresent(Int.self, forKey: .streaming)) ?? 0)
        callsPerMin = max(0, (try? c.decodeIfPresent(Int.self, forKey: .callsPerMin)) ?? 0)
    }

    private enum CodingKeys: String, CodingKey { case callsNow, streaming, callsPerMin }
}

enum WorldStatus: String, Equatable {
    case idle, busy, stale
}

struct WorldMachine: Decodable, Equatable, Identifiable {
    /// Opaque stable id (a keyed hash).
    let id: String
    /// Masked label, e.g. "lin-•••3f2a".
    let label: String
    let mine: Bool
    /// Your machine's real name; always nil for anyone else's.
    let name: String?
    /// OS family: macos, linux, windows, ios, android, other.
    let os: String
    let region: String?
    let country: String?
    let continent: String?
    let computeClass: String
    let models: [String]
    let activeModel: String?
    let status: WorldStatus
    let slots: Int
    let slotsUsed: Int
    let coordinatorId: String
    /// The coordinator's measured round trip to this machine, ms.
    let rttMs: Double?
    /// Absent from coordinators older than the pulses.
    let activity: WorldActivity?

    init(id: String, label: String, mine: Bool, name: String?, os: String, region: String? = nil, country: String? = nil,
         continent: String? = nil, computeClass: String = "cpu", models: [String] = [], activeModel: String? = nil,
         status: WorldStatus, slots: Int = 1, slotsUsed: Int = 0, coordinatorId: String, rttMs: Double? = nil,
         activity: WorldActivity? = nil) {
        self.id = id
        self.label = label
        self.mine = mine
        self.name = mine ? name : nil
        self.os = os
        self.region = region
        self.country = country
        self.continent = continent
        self.computeClass = computeClass
        self.models = models
        self.activeModel = activeModel
        self.status = status
        self.slots = slots
        self.slotsUsed = slotsUsed
        self.coordinatorId = coordinatorId
        self.rttMs = rttMs
        self.activity = activity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        coordinatorId = try c.decode(String.self, forKey: .coordinatorId)
        mine = (try? c.decodeIfPresent(Bool.self, forKey: .mine)) == true
        // Defense in depth: only your own machine keeps a name.
        name = mine ? (try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil : nil
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil ?? "machine-•••"
        os = (try? c.decodeIfPresent(String.self, forKey: .os)) ?? nil ?? ""
        region = (try? c.decodeIfPresent(String.self, forKey: .region)) ?? nil
        country = (try? c.decodeIfPresent(String.self, forKey: .country)) ?? nil
        continent = (try? c.decodeIfPresent(String.self, forKey: .continent)) ?? nil
        computeClass = (try? c.decodeIfPresent(String.self, forKey: .computeClass)) ?? nil ?? "cpu"
        models = (try? c.decodeIfPresent([String].self, forKey: .models)) ?? nil ?? []
        activeModel = (try? c.decodeIfPresent(String.self, forKey: .activeModel)) ?? nil
        status = WorldStatus(rawValue: (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil ?? "") ?? .stale
        slots = max(1, (try? c.decodeIfPresent(Int.self, forKey: .slots)) ?? nil ?? 1)
        slotsUsed = max(0, (try? c.decodeIfPresent(Int.self, forKey: .slotsUsed)) ?? nil ?? 0)
        rttMs = (try? c.decodeIfPresent(Double.self, forKey: .rttMs)) ?? nil
        activity = (try? c.decodeIfPresent(WorldActivity.self, forKey: .activity)) ?? nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, mine, name, os, region, country, continent, computeClass, models, activeModel, status, slots, slotsUsed, coordinatorId, rttMs, activity
    }
}

struct WorldCoordinator: Decodable, Equatable, Identifiable {
    let id: String
    let url: String
    let region: String?
    let country: String?
    let continent: String?
    let agents: Int
    let agentsOnline: Int
    let reachable: Bool
    /// Its public /identity on an https origin, for timing your round trip; nil when unreachable.
    let pingUrl: String?

    init(id: String, url: String, region: String? = nil, country: String? = nil, continent: String? = nil,
         agents: Int = 0, agentsOnline: Int = 0, reachable: Bool = true, pingUrl: String? = nil) {
        self.id = id
        self.url = url
        self.region = region
        self.country = country
        self.continent = continent
        self.agents = agents
        self.agentsOnline = agentsOnline
        self.reachable = reachable
        self.pingUrl = pingUrl
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = (try? c.decodeIfPresent(String.self, forKey: .url)) ?? nil ?? ""
        region = (try? c.decodeIfPresent(String.self, forKey: .region)) ?? nil
        country = (try? c.decodeIfPresent(String.self, forKey: .country)) ?? nil
        continent = (try? c.decodeIfPresent(String.self, forKey: .continent)) ?? nil
        agents = max(0, (try? c.decodeIfPresent(Int.self, forKey: .agents)) ?? nil ?? 0)
        agentsOnline = max(0, (try? c.decodeIfPresent(Int.self, forKey: .agentsOnline)) ?? nil ?? 0)
        reachable = (try? c.decodeIfPresent(Bool.self, forKey: .reachable)) ?? nil ?? true
        pingUrl = (try? c.decodeIfPresent(String.self, forKey: .pingUrl)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case id, url, region, country, continent, agents, agentsOnline, reachable, pingUrl }
}

struct WorldLink: Decodable, Equatable {
    let from: String
    let to: String
    let rttMs: Double?
    /// Work (task offers, claims, results, calls sent elsewhere) across the link in the last minute.
    let workPerMin: Int
    /// Other mesh messages across the link in the last minute.
    let gossipPerMin: Int

    init(from: String, to: String, rttMs: Double? = nil, workPerMin: Int = 0, gossipPerMin: Int = 0) {
        self.from = from
        self.to = to
        self.rttMs = rttMs
        self.workPerMin = workPerMin
        self.gossipPerMin = gossipPerMin
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(String.self, forKey: .from)
        to = try c.decode(String.self, forKey: .to)
        rttMs = (try? c.decodeIfPresent(Double.self, forKey: .rttMs)) ?? nil
        workPerMin = max(0, (try? c.decodeIfPresent(Int.self, forKey: .workPerMin)) ?? nil ?? 0)
        gossipPerMin = max(0, (try? c.decodeIfPresent(Int.self, forKey: .gossipPerMin)) ?? nil ?? 0)
    }

    private enum CodingKeys: String, CodingKey { case from, to, rttMs, workPerMin, gossipPerMin }
}

enum WorldRequestState: String, Decodable, Equatable {
    case queued, starting, streaming
}

/// One of your own requests in flight: the coordinator it is on and the (masked) machine running it.
struct WorldYourRequest: Decodable, Equatable {
    let coordinator: String
    let machineKey: String?
    let state: WorldRequestState
}

struct WorldTotals: Decodable, Equatable {
    let coordinators: Int?
    let agents: Int?
    let online: Int?
    let busy: Int?
    let mine: Int?
}

struct NetworkWorld: Decodable, Equatable {
    let connected: Bool
    let generatedAtMs: Double?
    let coordinators: [WorldCoordinator]
    let links: [WorldLink]
    let agents: [WorldMachine]
    let totals: WorldTotals?
    let yourRequests: [WorldYourRequest]
    let truncated: Bool

    init(coordinators: [WorldCoordinator], links: [WorldLink] = [], agents: [WorldMachine], totals: WorldTotals? = nil,
         yourRequests: [WorldYourRequest] = [], connected: Bool = true, generatedAtMs: Double? = nil, truncated: Bool = false) {
        self.connected = connected
        self.generatedAtMs = generatedAtMs
        self.coordinators = coordinators
        self.links = links
        self.agents = agents
        self.totals = totals
        self.yourRequests = yourRequests
        self.truncated = truncated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = (try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? nil ?? true
        generatedAtMs = (try? c.decodeIfPresent(Double.self, forKey: .generatedAtMs)) ?? nil
        coordinators = Self.lenientArray(c, .coordinators)
        links = Self.lenientArray(c, .links)
        agents = Self.lenientArray(c, .agents)
        totals = (try? c.decodeIfPresent(WorldTotals.self, forKey: .totals)) ?? nil
        yourRequests = Self.lenientArray(c, .yourRequests)
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? nil ?? false
    }

    /// An array where one bad element is dropped instead of failing the whole answer.
    private static func lenientArray<T: Decodable>(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [T] {
        guard let items = try? c.decodeIfPresent([Lenient<T>].self, forKey: key) else { return [] }
        return items.compactMap(\.value)
    }

    private enum CodingKeys: String, CodingKey { case connected, generatedAtMs, coordinators, links, agents, totals, yourRequests, truncated }
}

private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

// MARK: - Wording (the web's and desktop's)

enum NetworkText {
    static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }

    /// "3 coordinators · 41 machines online · 120 calls/min".
    static func summary(_ w: NetworkWorld) -> String {
        let coordinators = w.coordinators.count
        let online = w.totals?.online ?? w.agents.filter { $0.status != .stale }.count
        let perMin = w.agents.reduce(0) { $0 + NetworkGraph.activityOf($1).callsPerMin }
        return "\(plural(coordinators, "coordinator")) · \(plural(online, "machine")) online · \(perMin) calls/min"
    }

    static func statusText(_ s: WorldStatus) -> String {
        switch s {
        case .busy: return "Busy"
        case .idle: return "Idle"
        case .stale: return "Not seen lately"
        }
    }

    /// "Serving 2 calls now · 14 calls in the last minute".
    static func activityText(_ a: WorldMachine) -> String {
        let act = NetworkGraph.activityOf(a)
        let now = act.callsNow > 0 ? "Serving \(plural(act.callsNow, "call")) now" : "Not serving any calls now"
        return now + " · " + (act.callsPerMin > 0 ? "\(plural(act.callsPerMin, "call")) in the last minute" : "none in the last minute")
    }

    static func osFamily(_ os: String) -> String {
        switch os.lowercased() {
        case "macos": return "macOS"
        case "linux": return "Linux"
        case "windows": return "Windows"
        case "ios": return "iOS"
        case "android": return "Android"
        default: return "Other"
        }
    }

    static let continents = ["NA": "North America", "SA": "South America", "EU": "Europe", "AF": "Africa", "AS": "Asia", "OC": "Oceania"]

    /// "sin · SG", or the continent, or "Unknown".
    static func regionText(region: String?, country: String?, continent: String?) -> String {
        let parts = [region, country].compactMap { $0 }.filter { !$0.isEmpty }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if let c = continent { return continents[c] ?? c }
        return "Unknown"
    }

    /// The region text in the hub circle: "IAD", or "?".
    static func hubRegion(_ c: WorldCoordinator) -> String {
        (c.region.flatMap { $0.isEmpty ? nil : $0 } ?? "?").uppercased()
    }

    static func hostOf(_ url: String) -> String { URL(string: url)?.host ?? url }

    static func formatMs(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        return ms < 1 ? "<1 ms" : "\(Int(ms.rounded())) ms"
    }

    /// Your machine's name, short enough for the map ("desktop-macbook-pro-local-5173" reads "macbook-pro").
    static func shortMachineName(_ name: String) -> String {
        var s = name.replacingOccurrences(of: "^desktop-", with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "-local-[0-9a-z]+$", with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "\\.local$", with: "", options: [.regularExpression, .caseInsensitive])
        if s.isEmpty { s = name }
        return s.count > 22 ? String(s.prefix(21)) + "…" : s
    }
}

// MARK: - Layout (a port of worldLayout in desktop/src/lib/world-view.ts, without "You")

struct HubNode: Equatable, Identifiable {
    let id: String
    let x: Double
    let y: Double
    let coordinator: WorldCoordinator
}

struct MachineNode: Equatable, Identifiable {
    let id: String
    let x: Double
    let y: Double
    let r: Double
    let hubId: String
    let machine: WorldMachine
}

enum LabelAnchor: Equatable { case leading, trailing, center }

/// A name on the map. Only your own machines get one.
struct MachineLabel: Equatable {
    let id: String
    let text: String
    let x: Double
    let y: Double
    let anchor: LabelAnchor
}

struct GuideRing: Equatable {
    let hubId: String
    let r: Double
    let ms: Int
}

struct WorldLayout: Equatable {
    let width: Double
    let height: Double
    let hubs: [HubNode]
    let machines: [MachineNode]
    let rings: [GuideRing]
    let labels: [MachineLabel]
    /// Coordinator-to-coordinator links whose two ends are on the map.
    let links: [WorldLink]
}

enum NetworkGraph {
    static let ringMin = 46.0
    static let ringMax = 138.0
    static let cell = 2 * ringMax + 64
    static let hubR = 26.0
    static let msLo = 5.0
    static let msHi = 400.0
    static let lineClear = 0.26
    static let minStep = 0.16
    /// West to east, so the hubs sit roughly where they are.
    static let continentX = ["NA": 0, "SA": 1, "EU": 2, "AF": 3, "AS": 4, "OC": 5]

    /// Distance from the hub for a round trip: log scale from msLo (ringMin) to msHi (ringMax); unknown at the edge.
    static func ringRadius(_ ms: Double?) -> Double {
        guard let ms else { return ringMax }
        let t = log(max(ms, msLo) / msLo) / log(msHi / msLo)
        return round1(ringMin + (ringMax - ringMin) * min(1, max(0, t)))
    }

    /// Node size by model slots, a little larger for a GPU.
    static func nodeRadius(_ a: WorldMachine) -> Double {
        round1(5 + Double(min(a.slots, 8)) * 0.9 + (a.computeClass.hasPrefix("gpu") ? 2 : 0))
    }

    /// Columns of hubs: up to 3 across (the web's), 2 on a portrait screen.
    static func columns(coordinators: Int, portrait: Bool) -> Int {
        max(1, min(portrait ? 2 : 3, coordinators))
    }

    /// Columns of hubs (1 to 3) that draw the map largest in a width x height space: a tall window
    /// stacks the coordinators, a wide one puts them side by side. Ties go to fewer columns. Three or
    /// more never go in a single column: the outer hubs' link would run straight through the middle one.
    static func fitColumns(coordinators: Int, width: Double, height: Double) -> Int {
        guard coordinators > 1, width > 0, height > 0 else { return 1 }
        let fewest = coordinators >= 3 ? 2 : 1
        var best = fewest, bestScale = 0.0
        for c in fewest...min(3, coordinators) {
            let rows = Double((coordinators + c - 1) / c)
            let scale = min(width / (Double(c) * cell), height / (rows * cell))
            if scale > bestScale * 1.0001 { best = c; bestScale = scale }
        }
        return best
    }

    /// Coordinators as hubs (west to east, `columns` to a row), each machine on a ring around its
    /// coordinator at a distance set by the coordinator's round trip to it, spread evenly by region and
    /// clear of the coordinator lines. Deterministic: the same answer lays out the same.
    static func layout(_ w: NetworkWorld, columns: Int = 3) -> WorldLayout {
        let coords = w.coordinators.sorted {
            let ax = continentX[$0.continent ?? ""] ?? 9, bx = continentX[$1.continent ?? ""] ?? 9
            return ax != bx ? ax < bx : $0.id < $1.id
        }
        let perRow = max(1, min(columns, coords.count))
        let hubs = coords.enumerated().map { i, c in
            HubNode(id: c.id, x: cell / 2 + Double(i % perRow) * cell, y: cell / 2 + Double(i / perRow) * cell, coordinator: c)
        }
        var hubById: [String: HubNode] = [:]
        for h in hubs { hubById[h.id] = h }
        let links = w.links.filter { hubById[$0.from] != nil && hubById[$0.to] != nil && $0.from != $0.to }
        let rowsCount = Int(ceil(Double(hubs.count) / Double(perRow)))
        let width = max(cell, Double(perRow) * cell)
        let height = max(cell, Double(rowsCount) * cell)

        var byHub: [String: [WorldMachine]] = [:]
        for a in w.agents where hubById[a.coordinatorId] != nil { byHub[a.coordinatorId, default: []].append(a) }

        var machines: [MachineNode] = []
        for hub in hubs {
            guard let list = byHub[hub.id] else { continue }
            let sorted = list.sorted {
                let kx = [$0.continent ?? "~", $0.region ?? "~", $0.id], ky = [$1.continent ?? "~", $1.region ?? "~", $1.id]
                return kx.lexicographicallyPrecedes(ky)
            }
            // Directions to keep clear: the ring labels (top, a little right) and each coordinator line.
            var blocked: [(Double, Double)] = [(-Double.pi / 2 + 0.2, 0.26)]
            for l in links {
                let other = l.from == hub.id ? hubById[l.to] : l.to == hub.id ? hubById[l.from] : nil
                if let o = other { blocked.append((atan2(o.y - hub.y, o.x - hub.x), lineClear)) }
            }
            let angles = spreadAngles(sorted.count, blocked: blocked)
            for (i, a) in sorted.enumerated() {
                let d = ringRadius(a.rttMs)
                machines.append(MachineNode(id: a.id, x: round1(hub.x + d * cos(angles[i])), y: round1(hub.y + d * sin(angles[i])),
                                            r: nodeRadius(a), hubId: hub.id, machine: a))
            }
        }
        let rings = hubs.flatMap { h in [20, 100].map { GuideRing(hubId: h.id, r: ringRadius(Double($0)), ms: $0) } }
        return WorldLayout(width: width, height: height, hubs: hubs, machines: machines, rings: rings,
                           labels: labels(machines: machines, hubs: hubById), links: links)
    }

    /// Your machines' names, each placed outward from its hub. Nobody else's machine is named.
    static func labels(machines: [MachineNode], hubs: [String: HubNode]) -> [MachineLabel] {
        machines.compactMap { n in
            guard n.machine.mine, let name = n.machine.name, !name.isEmpty, let hub = hubs[n.hubId] else { return nil }
            let dx = n.x - hub.x, dy = n.y - hub.y
            let len = max(0.001, hypot(dx, dy))
            let ux = dx / len, uy = dy / len
            let gap = n.r + 7
            let anchor: LabelAnchor = ux > 0.35 ? .leading : ux < -0.35 ? .trailing : .center
            return MachineLabel(id: n.id, text: NetworkText.shortMachineName(name), x: round1(n.x + ux * gap),
                                y: round1(n.y + uy * gap), anchor: anchor)
        }
    }

    /// `n` angles around a hub, spread evenly from the top (clockwise) over the directions left free by
    /// `blocked` ([centre, half-width] in radians). When the machines would sit closer than minStep the
    /// gaps shrink, down to none.
    static func spreadAngles(_ n: Int, blocked: [(Double, Double)]) -> [Double] {
        guard n > 0 else { return [] }
        let tau = 2 * Double.pi
        let total = blocked.reduce(0) { $0 + 2 * $1.1 }
        let k = total > 0 ? max(0, min(1, (tau - Double(n) * minStep) / total)) : 0
        var iv: [(Double, Double)] = []
        for b in blocked {
            let w = b.1 * k
            guard w > 0 else { continue }
            let lo = ((b.0 - w + Double.pi / 2).truncatingRemainder(dividingBy: tau) + tau).truncatingRemainder(dividingBy: tau)
            let hi = lo + 2 * w
            if hi > tau {
                iv.append((lo, tau))
                iv.append((0, hi - tau))
            } else {
                iv.append((lo, hi))
            }
        }
        iv.sort { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
        var free: [(Double, Double)] = []
        var at = 0.0
        for v in iv {
            if v.0 > at { free.append((at, v.0)) }
            at = max(at, v.1)
        }
        if at < tau { free.append((at, tau)) }
        let len = free.reduce(0) { $0 + $1.1 - $1.0 }
        return (0..<n).map { i in
            var t = len > 0 ? (Double(i) + 0.5) * len / Double(n) : (Double(i) + 0.5) * tau / Double(n)
            var a = -Double.pi / 2 + t
            if len > 0 {
                for f in free {
                    let span = f.1 - f.0
                    if t <= span {
                        a = -Double.pi / 2 + f.0 + t
                        break
                    }
                    t -= span
                }
            }
            return (a * 10_000).rounded() / 10_000
        }
    }

    private static func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }

    // MARK: Activity and pulses (pulseLanes in world-view.ts)

    static let maxDots = 60
    static let maxPerLane = 4
    /// Travel times (ms), fastest first: a busier line moves faster.
    static let periods: [Double] = [900, 1400, 2000, 3000]
    /// A quiet mesh line breathes once in this long (liveness, not traffic).
    static let heartbeatMs = 8000.0

    /// A machine's activity; an older coordinator's answer falls back to its slots in use.
    static func activityOf(_ a: WorldMachine) -> WorldActivity {
        if a.status == .stale { return WorldActivity(callsNow: 0, streaming: 0, callsPerMin: a.activity?.callsPerMin ?? 0) }
        if let act = a.activity { return act }
        return WorldActivity(callsNow: a.status == .busy ? max(1, a.slotsUsed) : 0, streaming: 0, callsPerMin: 0)
    }

    static func pulsePeriod(_ perMin: Int) -> Double {
        perMin >= 60 ? periods[0] : perMin >= 20 ? periods[1] : perMin >= 5 ? periods[2] : periods[3]
    }

    /// Static intensity of a line (0 quiet .. 3 busiest): its thickness, and all reduced motion shows.
    static func pulseLevel(_ count: Int, _ perMin: Int) -> Int {
        if count <= 0 { return 0 }
        if count >= 3 || perMin >= 60 { return 3 }
        if count >= 2 || perMin >= 20 { return 2 }
        return 1
    }

    static func machinePulseCount(_ act: WorldActivity) -> Int {
        guard act.callsNow > 0 else { return 0 }
        let base = act.streaming > 0 ? act.streaming : 1
        return min(maxPerLane, base + (act.callsPerMin >= 30 ? 1 : 0))
    }

    static func meshPulseCount(_ workPerMin: Int) -> Int {
        guard workPerMin > 0 else { return 0 }
        return min(maxPerLane, 1 + workPerMin / 10)
    }

    /// Masked machine ids (in this view) running your requests, and the coordinators your requests are on.
    static func yourPath(_ w: NetworkWorld) -> (machines: Set<String>, coordinators: Set<String>) {
        let known = Set(w.coordinators.map(\.id))
        let onView = Set(w.agents.map(\.id))
        var machines = Set<String>(), coords = Set<String>()
        for r in w.yourRequests where known.contains(r.coordinator) {
            coords.insert(r.coordinator)
            if let k = r.machineKey, onView.contains(k) { machines.insert(k) }
        }
        return (machines, coords)
    }

    /// The pulses to draw: machine lines while a machine runs calls (toward the coordinator while a reply
    /// streams, else one dot toward the machine), mesh lines both ways scaled by work a minute (gossip
    /// alone is one faint dot; a quiet line only breathes). Capped at `cap` dots: your own lines first,
    /// then the busiest.
    static func pulseLanes(_ w: NetworkWorld, layout: WorldLayout, cap: Int = maxDots) -> [PulseLane] {
        let path = yourPath(w)
        var hubs: [String: HubNode] = [:]
        for h in layout.hubs { hubs[h.id] = h }
        var lanes: [PulseLane] = []
        for node in layout.machines {
            guard let hub = hubs[node.hubId] else { continue }
            let act = activityOf(node.machine)
            let count = machinePulseCount(act)
            let yours = path.machines.contains(node.id)
            guard count > 0 || yours else { continue }
            let out = act.streaming > 0
            lanes.append(PulseLane(
                id: "spoke:" + node.id, kind: .spoke,
                x1: out ? node.x : hub.x, y1: out ? node.y : hub.y, x2: out ? hub.x : node.x, y2: out ? hub.y : node.y,
                twoWay: false, count: max(count, yours ? 1 : 0), periodMs: out ? pulsePeriod(act.callsPerMin) : periods[3],
                level: pulseLevel(max(count, yours ? 1 : 0), act.callsPerMin), yours: yours, faint: false, heartbeat: false))
        }
        for link in layout.links {
            guard let a = hubs[link.from], let b = hubs[link.to] else { continue }
            let count = meshPulseCount(link.workPerMin)
            let up = a.coordinator.reachable && b.coordinator.reachable
            lanes.append(PulseLane(
                id: "mesh:" + [link.from, link.to].sorted().joined(separator: "|"), kind: .mesh,
                x1: a.x, y1: a.y, x2: b.x, y2: b.y, twoWay: count > 1,
                count: count > 0 ? count : link.gossipPerMin > 0 && up ? 1 : 0,
                periodMs: count > 0 ? pulsePeriod(link.workPerMin) : periods[3],
                level: pulseLevel(count, link.workPerMin), yours: false, faint: count == 0,
                heartbeat: count == 0 && link.gossipPerMin == 0 && up))
        }
        let order = lanes.indices.sorted { i, j in
            let x = lanes[i], y = lanes[j]
            if x.yours != y.yours { return x.yours }
            if x.faint != y.faint { return !x.faint }
            if x.count != y.count { return x.count > y.count }
            return x.id < y.id
        }
        var left = max(0, cap)
        for i in order {
            let take = min(lanes[i].count, left)
            lanes[i].count = take
            left -= take
        }
        return lanes
    }

    /// Where dot `index` of a lane is at `clockMs` (0..1 along it, and which way), on the wall clock so a
    /// refresh carries on where the last frame was.
    static func pulseProgress(_ lane: PulseLane, index: Int, clockMs: Double) -> (t: Double, reversed: Bool) {
        let p = lane.periodMs
        let shifted = clockMs.truncatingRemainder(dividingBy: p) + Double(index) * p / Double(max(1, lane.count))
        let offset = (shifted.truncatingRemainder(dividingBy: p) + p).truncatingRemainder(dividingBy: p)
        return (offset / p, lane.twoWay && index % 2 == 1)
    }
}

struct PulseLane: Equatable, Identifiable {
    enum Kind: Equatable { case spoke, mesh }
    let id: String
    let kind: Kind
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let twoWay: Bool
    var count: Int
    let periodMs: Double
    let level: Int
    let yours: Bool
    let faint: Bool
    let heartbeat: Bool
}
