import Foundation

/// The web chat API (src/portal/routes/chat.ts, conversations.ts) over the session cookie:
/// POST /portal/api/conversations, then POST /portal/api/chat with `compute: { target: "auto" }`
/// (your own online machines first, free; then the network's best fit, billed in cSats) and, unless
/// web search is off, `web: true` (docs/web-tool.md: the model may search; `{web}` progress,
/// `{webOff}` when it can't, sources and a footer on `done`). The reply
/// is an HTTP error while nothing was sent, else SSE: `data: {...}` events, ": keepalive"
/// heartbeats, and `data: [DONE]`.

/// What to run a chat on (the portal's chatComputeSchema).
enum PortalChatCompute: Equatable {
    case auto
    case network(model: String)
    case mine(model: String)

    var json: [String: String] {
        switch self {
        case .auto: return ["target": "auto"]
        case .network(let model): return ["target": "network", "model": model]
        case .mine(let model): return ["target": "mine", "model": model]
        }
    }
}

/// A numbered web source the answer cites (src/web-tool/tools.ts WebSource).
struct PortalWebSource: Codable, Equatable, Identifiable {
    let n: Int
    let title: String
    let url: String
    var id: Int { n }

    /// The link, only for http(s) (the web page's renderWebSources skips anything else).
    var link: URL? {
        guard let u = URL(string: url), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return u
    }

    /// "example.com" beside the title.
    var host: String {
        guard let h = link?.host else { return "" }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }
}

/// The web tool's running total for one reply (`{web: {...}}`), and on `done` the cited sources and
/// the footer "2 searches · 1 page · 1.2 cSats", or "2 searches · free (your machine)" when the chat
/// ran on the user's own machine (`free: true`; docs/web-tool.md).
struct PortalWebUsage: Codable, Equatable {
    var searches: Int
    var pages: Int
    var cSats: Double
    var sources: [PortalWebSource]
    var footer: String?
    /// Every web call was free: the chat ran on your own machine (the server's `free: true`).
    var free: Bool? = nil

    static let freeOnYourMachine = "free (your machine)"

    /// The server's footer, else the same line built here (src/web-tool/tools.ts webFooter).
    var footerLine: String {
        if let footer, !footer.isEmpty { return footer }
        return Self.footer(searches: searches, pages: pages, cSats: cSats, free: free == true)
    }

    /// "2 searches · 1 page · 1.2 cSats", or "… · free (your machine)"; "" when the web wasn't used.
    static func footer(searches: Int, pages: Int, cSats: Double, free: Bool = false) -> String {
        var parts: [String] = []
        if searches > 0 { parts.append("\(searches) search\(searches == 1 ? "" : "es")") }
        if pages > 0 { parts.append("\(pages) page\(pages == 1 ? "" : "s")") }
        if parts.isEmpty { return "" }
        if free && cSats == 0 {
            parts.append(freeOnYourMachine)
            return parts.joined(separator: " \u{00B7} ")
        }
        // JS `Number(x.toFixed(2))`: at most two decimals, no trailing zeros.
        let rounded = (cSats * 100).rounded() / 100
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.usesGroupingSeparator = false
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = 2
        parts.append("\(f.string(from: NSNumber(value: rounded)) ?? String(rounded)) cSats")
        return parts.joined(separator: " \u{00B7} ")
    }

    static func parse(_ raw: Any?) -> PortalWebUsage? {
        guard let obj = raw as? [String: Any] else { return nil }
        var sources: [PortalWebSource] = []
        for s in (obj["sources"] as? [[String: Any]]) ?? [] {
            guard let url = s["url"] as? String, !url.isEmpty else { continue }
            let n = (s["n"] as? NSNumber)?.intValue ?? sources.count + 1
            sources.append(PortalWebSource(n: n, title: (s["title"] as? String) ?? "", url: url))
        }
        let footer = (obj["footer"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return PortalWebUsage(searches: (obj["searches"] as? NSNumber)?.intValue ?? 0,
                              pages: (obj["pages"] as? NSNumber)?.intValue ?? 0,
                              cSats: (obj["cSats"] as? NSNumber)?.doubleValue ?? 0,
                              sources: sources, footer: footer,
                              free: (obj["free"] as? Bool) == true ? true : nil)
    }
}

/// One event of the chat stream.
enum PortalChatEvent: Equatable {
    case content(String)
    /// A note for the "Thinking..." line (e.g. "Answering with EdgeCoder's own model (free, slower)...").
    case status(String)
    case warning(String)
    case error(message: String, code: String?, httpStatus: Int?)
    /// The web tool's running total while the reply works (after each search or page read).
    case web(PortalWebUsage)
    /// The web tools weren't offered for this reply: `needs_csats` or `rate_limited`, with a note.
    case webOff(reason: String, message: String)
    /// The end of the reply; `web` (sources and footer) when the web was used.
    case done(cSatsSpent: Double?, compute: String?, calls: [CallUsage]?, web: PortalWebUsage?)
    case end
}

enum PortalChatParser {
    /// The events one SSE line carries ([] for heartbeats, blank lines and anything unparseable).
    /// One `data:` object can carry several fields (the web chat checks each), in this order.
    static func events(fromLine raw: String) -> [PortalChatEvent] {
        let line = raw.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("data:") else { return [] }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return [.end] }
        guard let data = payload.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        var out: [PortalChatEvent] = []
        if let s = obj["status"] as? String, !s.isEmpty { out.append(.status(s)) }
        if let w = obj["warning"] as? String, !w.isEmpty { out.append(.warning(w)) }
        if let off = obj["webOff"] as? [String: Any], let reason = off["reason"] as? String, !reason.isEmpty {
            out.append(.webOff(reason: reason, message: (off["message"] as? String) ?? ""))
        }
        if obj["done"] as? Bool != true, let w = PortalWebUsage.parse(obj["web"]) { out.append(.web(w)) }
        if let e = obj["error"] as? String, !e.isEmpty {
            out.append(.error(message: e, code: obj["code"] as? String, httpStatus: (obj["httpStatus"] as? NSNumber)?.intValue))
        }
        if obj["done"] as? Bool == true {
            // #415/#416: the per-call usage rides in `usage.calls` (src/portal/reply-usage.ts).
            var calls: [CallUsage]?
            let usage = obj["usage"] as? [String: Any]
            if let raw = usage?["calls"] ?? obj["calls"], let d = try? JSONSerialization.data(withJSONObject: raw) {
                calls = try? JSONDecoder().decode([CallUsage].self, from: d)
            }
            out.append(.done(cSatsSpent: (obj["cSatsSpent"] as? NSNumber)?.doubleValue ?? (usage?["cSats"] as? NSNumber)?.doubleValue,
                             compute: (obj["compute"] as? String) ?? (usage?["where"] as? String), calls: calls,
                             web: PortalWebUsage.parse(obj["web"])))
        }
        if let c = obj["content"] as? String, !c.isEmpty { out.append(.content(c)) }
        return out
    }

    /// The error of a non-2xx answer (`{ error, code }`, or the raw text).
    static func refusal(status: Int, body: Data) -> PortalChatEvent {
        if let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
            let message = (obj["error"] as? String) ?? "Chat request failed: \(status)"
            return .error(message: message, code: obj["code"] as? String, httpStatus: status)
        }
        let text = String(data: body, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .error(message: text.isEmpty ? "Chat request failed: \(status)" : text, code: nil, httpStatus: status)
    }
}

final class PortalChatClient {
    static let shared = PortalChatClient(config: APIClient.shared.config)

    let config: AppConfig
    private let session: URLSession

    init(config: AppConfig) {
        self.config = config
        let c = URLSessionConfiguration.default
        c.httpCookieStorage = .shared
        c.httpShouldSetCookies = true
        c.httpCookieAcceptPolicy = .always
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        // The portal sends a heartbeat every 15 s once a reply takes longer than 4 s; a first token
        // can take over a minute on a cold model, so only a silence this long is a failure.
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 15 * 60
        self.session = URLSession(configuration: c)
    }

    /// A new server-side conversation (the portal keeps the history the model sees).
    func createConversation(title: String?) async throws -> String {
        struct Created: Decodable { let conversationId: String }
        var body: [String: String] = [:]
        if let title { body["title"] = String(title.prefix(200)) }
        let created: Created = try await APIClient.shared.request(baseURL: config.portalBaseURL, path: "/portal/api/conversations", method: "POST", body: body)
        return created.conversationId
    }

    /// The POST /portal/api/chat body. `web`: offer the web tools (the chat's "Web: Auto"); the portal
    /// still answers without them when they can't be used (no cSats, a model that can't call tools).
    static func chatBody(conversationId: String, message: String, compute: PortalChatCompute, resend: Bool = false, web: Bool) -> [String: Any] {
        var body: [String: Any] = ["conversationId": conversationId, "message": message, "compute": compute.json]
        if resend { body["resend"] = true }
        if web { body["web"] = true }
        return body
    }

    /// Sends one message and streams the reply's events (ending with `.end`, or an `.error`).
    func send(conversationId: String, message: String, compute: PortalChatCompute, resend: Bool = false, web: Bool) -> AsyncThrowingStream<PortalChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: config.portalBaseURL.appending(path: "/portal/api/chat"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let body = Self.chatBody(conversationId: conversationId, message: message, compute: compute, resend: resend, web: web)
                    req.httpBody = try JSONSerialization.data(withJSONObject: body)
                    let (bytes, response) = try await session.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
                    if !(200...299).contains(http.statusCode) {
                        var data = Data()
                        for try await b in bytes { data.append(b); if data.count > 64_000 { break } }
                        continuation.yield(PortalChatParser.refusal(status: http.statusCode, body: data))
                        continuation.finish()
                        return
                    }
                    for try await line in bytes.lines {
                        for event in PortalChatParser.events(fromLine: line) {
                            continuation.yield(event)
                            if event == .end { continuation.finish(); return }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

extension PortalChatEvent {
    var isContent: Bool { if case .content = self { return true } else { return false } }
}

/// Web search in chat (docs/web-tool.md), as the web chat and desktop app do it: automatic by
/// default (the model decides when a question needs the web), off for one chat from the Web menu
/// under the message box, and Settings > Chat "Search the web automatically" sets the default.
enum WebSearchPreference {
    /// Settings default (on unless turned off), kept on this iPhone.
    static let storageKey = "edgecoder.web.auto"
    /// The web chat's words (src/portal/pages/web-toggle.ts).
    static let needsCSatsNote = "Web search needs cSats"
    static let rateLimitedNote = "Web search's hourly limit is used up; it's back within the hour."
    /// A chat on your own machine (web free) after today's free searches (src/web-tool/tools.ts FREE_USED_NOTE).
    static let freeUsedNote = "Today's free web searches on your machine are used up"

    /// A chat's choice: "auto" or "off"; nil follows the Settings default.
    static func enabled(chatMode: String?, defaultOn: Bool) -> Bool {
        switch chatMode {
        case "off": return false
        case "auto": return true
        default: return defaultOn
        }
    }

    /// What to keep for a chat after picking `on` in its menu (nil when it matches the default).
    static func chatMode(on: Bool, defaultOn: Bool) -> String? {
        on == defaultOn ? nil : (on ? "auto" : "off")
    }

    /// The quiet note under a reply that answered without the web (`webOff`), or nil for reasons
    /// that aren't noted. Shown once per chat for each reason.
    static func offNote(reason: String, message: String) -> String? {
        switch reason {
        case "needs_csats": return message.isEmpty ? needsCSatsNote : message
        case "rate_limited": return message.isEmpty ? rateLimitedNote : message
        case "free_used": return message.isEmpty ? freeUsedNote : message
        default: return nil
        }
    }
}
