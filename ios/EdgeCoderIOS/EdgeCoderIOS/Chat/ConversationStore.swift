import Foundation

@MainActor
final class ConversationStore: ObservableObject {
    @Published var conversations: [Conversation] = []

    private let fileManager = FileManager.default

    private var conversationsDirectory: URL {
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Conversations")
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .millisecondsSince1970
        e.outputFormatting = .prettyPrinted
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .millisecondsSince1970
        return d
    }()

    // MARK: - Save

    func save(_ conversation: Conversation) {
        let url = conversationsDirectory.appendingPathComponent("\(conversation.id).json")
        do {
            let data = try encoder.encode(conversation)
            try data.write(to: url, options: .atomic)
        } catch {
            print("[ConversationStore] save failed: \(error.localizedDescription)")
        }
        // Update in-memory list
        if let idx = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[idx] = conversation
        } else {
            conversations.insert(conversation, at: 0)
        }
    }

    // MARK: - Load single

    func load(id: String) -> Conversation? {
        let url = conversationsDirectory.appendingPathComponent("\(id).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(Conversation.self, from: data)
    }

    // MARK: - List by source

    func list(source: Conversation.Source) -> [Conversation] {
        loadAll()
        return conversations
            .filter { $0.source == source }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Delete

    func delete(id: String) {
        let url = conversationsDirectory.appendingPathComponent("\(id).json")
        try? fileManager.removeItem(at: url)
        conversations.removeAll { $0.id == id }
    }

    // MARK: - Rename

    func rename(id: String, title: String) {
        guard var convo = load(id: id) else { return }
        convo.title = title
        convo.updatedAt = Date()
        save(convo)
    }

    // MARK: - Load all from disk

    func loadAll() {
        guard let files = try? fileManager.contentsOfDirectory(
            at: conversationsDirectory,
            includingPropertiesForKeys: nil
        ) else { return }

        var loaded: [Conversation] = []
        for file in files where file.pathExtension == "json" {
            if let data = try? Data(contentsOf: file),
               let convo = try? decoder.decode(Conversation.self, from: data) {
                loaded.append(convo)
            }
        }
        conversations = loaded.sorted { $0.updatedAt > $1.updatedAt }
    }

    // MARK: - Last active conversation tracking

    private let lastChatIdKey = "edgecoder.lastChatConversationId"
    private let lastEditorIdKey = "edgecoder.lastEditorConversationId"

    func saveLastId(_ id: String, source: Conversation.Source) {
        let key = source == .chat ? lastChatIdKey : lastEditorIdKey
        UserDefaults.standard.set(id, forKey: key)
    }

    func lastId(source: Conversation.Source) -> String? {
        let key = source == .chat ? lastChatIdKey : lastEditorIdKey
        return UserDefaults.standard.string(forKey: key)
    }
}
