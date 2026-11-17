import Foundation

/// The web chat API (src/portal/routes/chat.ts, conversations.ts) over the session cookie:
/// POST /portal/api/conversations, then POST /portal/api/chat with `compute: { target: "auto" }`
/// (your own online machines first, free; then the network's best fit, billed in cSats). The reply
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

/// One event of the chat stream.
enum PortalChatEvent: Equatable {
    case content(String)
    /// A note for the "Thinking..." line (e.g. "Answering with EdgeCoder's own model (free, slower)...").
    case status(String)
    case warning(String)
    case error(message: String, code: String?, httpStatus: Int?)
    case done(cSatsSpent: Double?, compute: String?, calls: [CallUsage]?)
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
        if let e = obj["error"] as? String, !e.isEmpty {
            out.append(.error(message: e, code: obj["code"] as? String, httpStatus: (obj["httpStatus"] as? NSNumber)?.intValue))
        }
        if obj["done"] as? Bool == true {
            var calls: [CallUsage]?
            if let raw = obj["calls"], let d = try? JSONSerialization.data(withJSONObject: raw) {
                calls = try? JSONDecoder().decode([CallUsage].self, from: d)
            }
            out.append(.done(cSatsSpent: (obj["cSatsSpent"] as? NSNumber)?.doubleValue, compute: obj["compute"] as? String, calls: calls))
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

    /// Sends one message and streams the reply's events (ending with `.end`, or an `.error`).
    func send(conversationId: String, message: String, compute: PortalChatCompute, resend: Bool = false) -> AsyncThrowingStream<PortalChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: config.portalBaseURL.appending(path: "/portal/api/chat"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    var body: [String: Any] = ["conversationId": conversationId, "message": message, "compute": compute.json]
                    if resend { body["resend"] = true }
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
