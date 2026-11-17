import Foundation

// MARK: - Chat Message

struct ChatMessage: Codable, Identifiable, Equatable {
    let id: String
    let role: Role
    let content: String
    let timestamp: Date
    /// The line under a finished reply: cSats spent and where it ran ("3.4 cSats · Network · best fit").
    var footer: String?
    /// A reply that could not run: the shared failure line and what to do (Buy cSats, Retry).
    var failure: ChatFailureInfo?
    /// The reply has text but stopped mid-sentence ("Reply may be cut short").
    var cutShort: Bool?
    /// Web answers: the numbered sources it cites (links under the reply).
    var webSources: [PortalWebSource]?
    /// Web answers: "2 searches · 1 page · 1.2 cSats".
    var webFooter: String?
    /// "Web search needs cSats" (once per chat) when the reply answered without the web.
    var webNote: String?

    enum Role: String, Codable {
        case user
        case assistant
        case system
    }

    init(role: Role, content: String, footer: String? = nil, failure: ChatFailureInfo? = nil, cutShort: Bool? = nil) {
        self.id = UUID().uuidString
        self.role = role
        self.content = content
        self.timestamp = Date()
        self.footer = footer
        self.failure = failure
        self.cutShort = cutShort
    }
}

/// A failed reply as the web chat shows it (src/portal/pages/chat.ts showChatFailure).
struct ChatFailureInfo: Codable, Equatable {
    let kind: ChatFailureKind
    let headline: String
    let detail: String
    /// The message to send again from Retry.
    let retryText: String?

    init(message: String?, code: String? = nil, httpStatus: Int? = nil, retryText: String?) {
        let kind = ChatFailures.kind(message: message, code: code, httpStatus: httpStatus)
        self.kind = kind
        self.headline = ChatFailures.headline(kind: kind, message: message)
        let detail = ChatFailures.detail(kind: kind, message: message)
        self.detail = kind == .other ? "" : detail
        self.retryText = retryText
    }

    var offersBuy: Bool { ChatFailures.offersBuy(kind) }
}

// MARK: - Conversation

struct Conversation: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var messages: [ChatMessage]
    let source: Source
    let createdAt: Date
    var updatedAt: Date
    var selectedModel: String?
    /// The portal conversation this chat continues (web chat API), created on the first network message.
    var portalConversationId: String?
    /// The Web menu's choice for this chat: "auto", "off", or nil for the Settings default.
    var webMode: String?
    /// The `webOff` reasons already noted under a reply in this chat (each is noted once).
    var webNotedReasons: [String]?

    enum Source: String, Codable {
        case chat
        case editor
    }

    init(source: Source) {
        self.id = UUID().uuidString
        self.title = "New Chat"
        self.messages = []
        self.source = source
        self.createdAt = Date()
        self.updatedAt = Date()
    }

    mutating func addMessage(role: ChatMessage.Role, content: String, footer: String? = nil, failure: ChatFailureInfo? = nil, cutShort: Bool? = nil) {
        let msg = ChatMessage(role: role, content: content, footer: footer, failure: failure, cutShort: cutShort)
        messages.append(msg)
        updatedAt = Date()
        // Auto-title from first user message
        if title == "New Chat", role == .user {
            let trimmed = content.prefix(60)
            title = trimmed.count < content.count ? "\(trimmed)..." : String(trimmed)
        }
    }
}

// MARK: - Route Decision

enum RouteDecision: String, Codable {
    case local = "local"
    case blePeer = "ble-peer"
    case swarm = "swarm"
    case offlineStub = "offline-stub"
}

struct ChatRouteResult {
    let route: RouteDecision
    let text: String
    let model: String
    let latencyMs: Int
    let creditsSpent: Int?
    let swarmTaskId: String?
}

// MARK: - Stream Progress

struct StreamProgress {
    var tokenCount: Int = 0
    var elapsedMs: Int = 0
    var route: RouteDecision?
    var routeLabel: String = ""
    var model: String = ""
    var creditsSpent: Double?
    /// The web tool's running total while the reply works ("1 search · 0.5 cSats").
    var webLine: String?

    var routeIcon: String {
        switch route {
        case .local: return "bolt.fill"
        case .blePeer: return "antenna.radiowaves.left.and.right"
        case .swarm: return "globe"
        case .offlineStub: return "moon.zzz"
        case .none: return "bolt.fill"
        }
    }

    static let verbs = [
        "Thinking", "Pondering", "Crafting", "Computing",
        "Reasoning", "Weaving", "Assembling", "Conjuring",
        "Brewing", "Forging",
    ]

    static func randomVerb() -> String {
        verbs.randomElement() ?? "Thinking"
    }
}
