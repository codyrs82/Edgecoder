import Foundation

/// What kind a chat failure is and the compact line a reply shows for it: a Swift port of
/// src/common/chat-failures.ts (the desktop app and the web chat use the same wording), plus the
/// web chat's detail helpers (src/portal/pages/chat.ts chatErrorText, csatsDetail, looksTruncated,
/// formatCSats). Keep the strings equal to the TypeScript; ChatFailuresTests pins them.
enum ChatFailureKind: String, Codable, Equatable {
    case csats, budget, `class`, offline, model, other
}

enum ChatFailures {
    /// Where "Buy cSats" goes on the web (Settings > Wallet), relative to the portal.
    static let buyCSatsPath = "/portal/settings/plan"

    /// The kind of a failure message (src/inference-api/auto-route.ts words them).
    static func kind(_ error: String?) -> ChatFailureKind {
        let e = (error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if matches(e, #"budget is spent|no cSats left today"#) { return .budget }
        if matches(e, #"not enough cSats|no cSats|insufficient|balance 0|costs more than the .* cSats ceiling"#) { return .csats }
        if matches(e, #"^No .+ machines? online|machine runs .* right now|no network .* machine has a model|no agent with a model is online"#) { return .class }
        if matches(e, #"isn't connected|not connected|offline|isn't running|unreachable"#) { return .offline }
        if matches(e, #"isn't installed|no model is installed|no model is available|no model fits|no model on the network fits"#) { return .model }
        return .other
    }

    /// The kind of a refusal from /portal/api/chat: its `code` and HTTP status first, as the web chat does.
    static func kind(message: String?, code: String?, httpStatus: Int?) -> ChatFailureKind {
        if code == "out_of_csats" || httpStatus == 402 { return .csats }
        return kind(message)
    }

    /// The compact conversation line.
    static func line(_ kind: ChatFailureKind) -> String {
        switch kind {
        case .csats: return "Couldn't run: out of cSats"
        case .budget: return "Couldn't run: today's budget is spent"
        case .class: return "Couldn't run: no machines of that class online"
        case .offline: return "Couldn't run: offline"
        case .model: return "Couldn't run: no model available"
        case .other: return "Couldn't run"
        }
    }

    /// The web chat's plain words for a raw error from the portal or the connection.
    static func errorText(_ message: String?) -> String {
        let m = message ?? ""
        switch m {
        case "all_coordinators_failed": return "EdgeCoder's model didn't answer. Try again in a moment."
        case "no_coordinators_available": return "Couldn't reach the EdgeCoder network. Try again in a moment."
        case "stream_interrupted": return "The reply was cut off."
        case "portal_database_not_configured": return "Chat is unavailable right now."
        case "not_authenticated": return "Your session ended. Sign in again."
        default: break
        }
        if matches(m, #"^(Load failed|Failed to fetch|NetworkError|network error|The network connection was lost)"#) {
            return "The connection to EdgeCoder dropped before the reply arrived."
        }
        return m.isEmpty ? "Something went wrong." : m
    }

    /// The out-of-cSats detail in our words: what the chat sets aside ("" when the message does not say).
    static func csatsDetail(_ message: String?) -> String {
        guard let m = message,
              let re = try? NSRegularExpression(pattern: #"up to ([0-9][0-9.,]*) cSats"#, options: [.caseInsensitive]),
              let hit = re.firstMatch(in: m, range: NSRange(m.startIndex..., in: m)),
              let r = Range(hit.range(at: 1), in: m) else { return "" }
        return "This chat sets aside up to \(m[r]) cSats; unused cSats come back."
    }

    /// The detail line under the compact line ("" for none), as the web chat shows it.
    static func detail(kind: ChatFailureKind, message: String?) -> String {
        kind == .csats ? csatsDetail(message) : errorText(message)
    }

    /// The headline a failed reply shows: the shared line, or the plain error for "other".
    static func headline(kind: ChatFailureKind, message: String?) -> String {
        kind == .other ? errorText(message) : line(kind)
    }

    /// Whether Buy cSats belongs under this failure.
    static func offersBuy(_ kind: ChatFailureKind) -> Bool { kind == .csats || kind == .budget }

    /// A reply whose text stops mid-sentence (no closing punctuation, or an unclosed code block).
    static func looksTruncated(_ text: String) -> Bool {
        let t = text.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        if t.isEmpty { return false }
        if (t.components(separatedBy: "```").count - 1) % 2 == 1 { return true }
        return !matches(t, #"[.!?:;)\]}"'`*_>|\x{2026}\x{3002}\x{FF01}\x{FF1F}]$"#)
    }

    /// "12.5 cSats", "0.0042 cSats", "1,234 cSats" (the web chat's formatCSats, en-US grouping).
    static func formatCSats(_ n: Double) -> String {
        let digits = n >= 100 ? 0 : n >= 1 ? 2 : 4
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = digits
        return (f.string(from: NSNumber(value: n)) ?? String(n)) + " cSats"
    }

    /// The line under a finished reply: "3.4 cSats · Network · best fit" (cSats spent, then where it ran).
    static func replyFooter(cSatsSpent: Double?, compute: String?) -> String? {
        let parts = [cSatsSpent.map { formatCSats($0) } ?? "", compute ?? ""].filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
}
