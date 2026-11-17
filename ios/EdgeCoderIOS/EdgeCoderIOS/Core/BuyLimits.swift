import Foundation

/// How much one Buy cSats can be right now, and plain-language text for purchase errors: a Swift
/// port of src/common/buy-limits.ts (shared by the portal and the desktop app). The coordinator
/// still enforces the caps; this only stops the app asking for what it will refuse.
struct LaunchCaps: Decodable, Equatable {
    var mode: String
    var maxBuySatsPerDay: Double
    var maxBalanceSats: Double
    var maxPayoutSatsPerDay: Double?
    var boughtWindowSats: Double?
}

struct BuyLimit: Equatable {
    enum Reason: String { case daily, balance, global }
    var minSats: Int
    /// The largest amount that fits right now (below minSats when nothing fits).
    var maxSats: Int
    var reason: Reason
    var dailyCapSats: Int?
    var dailyLeftSats: Int?
    var balanceCapSats: Int?
    var balanceLeftSats: Int?
}

enum BuyLimits {
    private static func g(_ n: Double) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n.rounded(.down))) ?? String(Int(n))
    }
    private static func g(_ n: Int) -> String { g(Double(n)) }

    static func limit(launch: LaunchCaps?, balanceCSats: Double?, feeBps: Int?, globalMin: Int = 100, globalMax: Int = 1_000_000) -> BuyLimit {
        let l = launch?.mode == "invite" ? launch : nil
        var out = BuyLimit(minSats: globalMin, maxSats: globalMax, reason: .global)
        if let l, l.maxBuySatsPerDay > 0 {
            out.dailyCapSats = Int(l.maxBuySatsPerDay)
            let left = max(0, Int((l.maxBuySatsPerDay - (l.boughtWindowSats ?? 0)).rounded(.down)))
            out.dailyLeftSats = left
            if left < out.maxSats { out.maxSats = left; out.reason = .daily }
        }
        if let l, l.maxBalanceSats > 0, let bal = balanceCSats, bal.isFinite {
            out.balanceCapSats = Int(l.maxBalanceSats)
            let left = max(0, Int((l.maxBalanceSats - bal).rounded(.down)))
            out.balanceLeftSats = left
            // The balance grows by amount minus the purchase fee, so a fee lets the amount be a bit larger.
            let fee = min(9_999, max(0, feeBps ?? 0))
            var amount = (left * 10_000) / (10_000 - fee)
            while amount > 0 && amount - (amount * fee) / 10_000 > left { amount -= 1 }
            if amount < out.maxSats { out.maxSats = amount; out.reason = .balance }
        }
        return out
    }

    /// An amount brought inside the limit (the minimum when nothing fits).
    static func clamp(_ amount: Int, _ limit: BuyLimit) -> Int { max(limit.minSats, min(amount, limit.maxSats)) }

    static func fits(_ amount: Int, _ limit: BuyLimit) -> Bool { amount >= limit.minSats && amount <= limit.maxSats }

    /// "100 to 50,000 today" under a cap, "100 to 1M" otherwise; "None left today" when nothing fits.
    static func rangeLabel(_ limit: BuyLimit) -> String {
        if limit.maxSats < limit.minSats { return limit.reason == .daily ? "None left today" : "None right now" }
        if limit.reason == .global { return g(limit.minSats) + " to " + (limit.maxSats == 1_000_000 ? "1M" : g(limit.maxSats)) }
        return g(limit.minSats) + " to " + g(limit.maxSats) + (limit.reason == .daily ? " today" : "")
    }

    /// Why an amount does not fit, before submit ("" when it fits). Amounts are whole sats here.
    static func limitText(_ amount: Int, _ limit: BuyLimit) -> String {
        if amount <= 0 { return "" }
        if amount < limit.minSats { return "The minimum is \(g(limit.minSats)) sats." }
        if amount <= limit.maxSats { return "" }
        if limit.reason == .daily, let cap = limit.dailyCapSats {
            return "Early access: up to \(g(cap)) sats per day (\(g(limit.dailyLeftSats ?? 0)) left today)."
        }
        if limit.reason == .balance, let cap = limit.balanceCapSats {
            return "Early access: a balance of up to \(g(cap)) cSats. You can add up to \(g(max(0, limit.maxSats))) sats now."
        }
        return "The most you can buy at once is \(g(limit.maxSats)) sats."
    }

    /// Plain-language text for a purchase error code (never the raw code).
    static func errorText(_ code: String?, remainingSats: Double? = nil, limitSats: Double? = nil) -> String {
        let left = remainingSats.map { max(0, $0) }
        switch code {
        case "launch_buy_daily_cap":
            if left == 0 { return "You've reached today's early-access limit" + (limitSats.map { $0 != 0 ? " of \(g($0)) sats" : "" } ?? "") + ". You can buy more once some of today's purchases are 24 hours old." }
            return "That's over today's early-access limit." + (left.map { " You can buy up to \(g($0)) sats more today." } ?? "")
        case "launch_balance_cap":
            if left == 0 { return "Your balance is at the early-access limit" + (limitSats.map { $0 != 0 ? " of \(g($0)) cSats" : "" } ?? "") + ". Spend some cSats before buying more." }
            return "That would take your balance over the early-access limit" + (limitSats.map { $0 != 0 ? " of \(g($0)) cSats" : "" } ?? "") + "." + (left.map { " You can add up to \(g($0)) cSats now." } ?? "")
        case "invalid_amount", "invalid_request": return "Enter whole sats from 100 to 1,000,000."
        case "amount_too_small", "below_minimum": return "The minimum purchase is 100 sats."
        case "amount_too_large", "above_maximum": return "The most you can buy at once is 1,000,000 sats."
        case "payments_disabled": return "Buying cSats is turned off on this coordinator."
        case "no_coordinator", "coordinator_unreachable", "lightning_unavailable", "invoice_failed": return "No payment could be started right now. Try again in a minute."
        case "not_enrolled": return "This computer isn't connected to your account yet. Sign in, then try again."
        case "not_authenticated", "unauthorized": return "Your session ended. Sign in again."
        case "rate_limited", "too_many_requests": return "Too many tries in a row. Wait a minute, then try again."
        default: return "Couldn't start the payment. Try again in a minute."
        }
    }
}
