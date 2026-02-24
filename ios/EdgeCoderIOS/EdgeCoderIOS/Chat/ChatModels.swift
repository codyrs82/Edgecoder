import Foundation

// MARK: - Chat Message

struct ChatMessage: Codable, Identifiable, Equatable {
    let id: String
    let role: Role
    let content: String
    let timestamp: Date

    enum Role: String, Codable {
        case user
        case assistant
        case system
    }

    init(role: Role, content: String) {
        self.id = UUID().uuidString
        self.role = role
        self.content = content
        self.timestamp = Date()
    }
}

// MARK: - Conversation

struct Conversation: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var messages: [ChatMessage]
    let source: Source
    let createdAt: Date
    var updatedAt: Date

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

    mutating func addMessage(role: ChatMessage.Role, content: String) {
        let msg = ChatMessage(role: role, content: content)
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
