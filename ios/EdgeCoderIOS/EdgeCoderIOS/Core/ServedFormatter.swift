import Foundation

/// Where a reply's model calls ran, as the footer under a reply shows it: a Swift port of
/// src/common/served.ts (= desktop/src/lib/served.ts; the terminal prints the same line). Used when
/// a chat's done event carries per-call `calls`; otherwise the footer is ChatFailures.replyFooter.
struct ServedInfo: Codable, Equatable {
    var label: String
    var own: Bool
    var computeClass: String
    var tier: String?
    var hardware: String
    var gpu: String?
    var region: String?
    var city: String?
    var country: String?
    var pickupMs: Double?
    var promptMs: Double?
    var genMs: Double?
    var promptTokens: Double?
    var outputTokens: Double?
    var usd: Double?
}

struct CallUsage: Codable, Equatable {
    var cSats: Double
    var `where`: String?
    var model: String?
    var served: ServedInfo?
}

enum ServedFormatter {
    static func tok(_ n: Double) -> String {
        guard n >= 1000 else { return String(Int(n)) }
        let v = n / 1000
        var s = n >= 100_000 ? String(format: "%.0f", v) : String(format: "%.1f", v)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s + "k"
    }

    static func secs(_ ms: Double) -> String {
        ms >= 10_000 ? "\(Int((ms / 1000).rounded())) s" : String(format: "%.1f s", ms / 1000)
    }

    static func cost(_ n: Double) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.maximumFractionDigits = 3
        return (f.string(from: NSNumber(value: n)) ?? String(n)) + " cSats"
    }

    /// "Datacenter GPU 2×A16", or the local hardware as given ("This computer (Apple M1 Max)").
    static func hardwareShort(_ s: ServedInfo) -> String {
        if s.computeClass == "local" { return s.hardware }
        let cls = s.hardware.replacingOccurrences(of: #"\s*\([^)]*\)\s*$"#, with: "", options: .regularExpression)
        var gpu = ""
        if let g = s.gpu {
            gpu = g.replacingOccurrences(of: #"^(\d+)× "#, with: "$1×", options: .regularExpression)
                .replacingOccurrences(of: #"^(\d+×)?(NVIDIA|AMD|Apple|Intel) "#, with: "$1", options: .regularExpression)
        }
        let extra = !gpu.isEmpty ? " \(gpu)" : (s.tier.map { " (\($0))" } ?? "")
        return cls + extra + (s.own ? " · your machine" : "")
    }

    /// `qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats`; nil without served calls.
    static func servedLine(_ calls: [CallUsage]?) -> String? {
        guard let calls else { return nil }
        let withServed = calls.filter { $0.served != nil }
        guard let last = withServed.last, let s = last.served else { return nil }
        var bits: [String] = []
        if s.computeClass == "frontier" {
            bits.append(String(s.hardware.components(separatedBy: " · ")[0]))
            bits.append((last.model ?? "").replacingOccurrences(of: #"^frontier/[^/]+/"#, with: "", options: .regularExpression))
            bits.append("your key")
        } else {
            if let m = last.model { bits.append(m.replacingOccurrences(of: #"^network/"#, with: "", options: .regularExpression)) }
            bits.append(hardwareShort(s))
            if let place = s.city ?? s.region ?? s.country { bits.append(place) }
        }
        let machines = Set(withServed.compactMap { $0.served?.label })
        if machines.count > 1 { bits.append("\(machines.count) machines") }
        func sum(_ k: KeyPath<ServedInfo, Double?>) -> Double { calls.reduce(0) { $0 + ($1.served?[keyPath: k] ?? 0) } }
        let pt = sum(\.promptTokens), pm = sum(\.promptMs), ot = sum(\.outputTokens), gm = sum(\.genMs)
        if pt > 0 { bits.append("read \(tok(pt)) tok" + (pm > 0 ? " in \(secs(pm))" : "")) }
        if ot > 0 { bits.append("wrote \(tok(ot)) tok" + (gm > 0 ? " in \(secs(gm))" : "")) }
        if calls.count > 1 { bits.append("\(calls.count) calls") }
        let total = calls.reduce(0) { $0 + ($1.cSats.isFinite ? $1.cSats : 0) }
        let anyFrontier = calls.contains { $0.served?.computeClass == "frontier" }
        if !anyFrontier || total > 0 {
            bits.append((s.computeClass == "local" || s.own) && total == 0 ? "free" : cost(total))
        }
        if anyFrontier {
            let usd = calls.reduce(0) { $0 + ($1.served?.usd ?? 0) }
            bits.append(usd > 0 && usd < 0.01 ? "<$0.01" : String(format: "$%.2f", usd))
        }
        return bits.joined(separator: " · ")
    }
}
