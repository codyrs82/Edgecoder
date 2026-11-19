import Combine
import Foundation

/// The drawer's Chat list: the conversations saved on this device (ConversationStore), newest first,
/// searchable by title and message text, deletable.
@MainActor
final class ChatDrawerSource: DrawerDataSource {
    @Published private(set) var conversations: [Conversation] = []
    @Published var selectedId: String?

    let title = "Chats"
    let newLabel: String? = "New chat"
    let searchPrompt = "Search chats"
    let emptyTitle = "No chats yet"
    let emptyMessage: String? = "Your conversations on this device will show here."
    let canDelete = true

    private let reloadAction: () -> Void
    private let deleteAction: (String) -> Void
    private let now: () -> Date
    private let calendar: Calendar

    /// `conversations` publishes every saved conversation (any source); this keeps the chat ones.
    init(
        conversations: AnyPublisher<[Conversation], Never>,
        reload: @escaping () -> Void = {},
        delete: @escaping (String) -> Void = { _ in },
        now: @escaping () -> Date = Date.init,
        calendar: Calendar = .current
    ) {
        self.reloadAction = reload
        self.deleteAction = delete
        self.now = now
        self.calendar = calendar
        conversations
            .map { all in all.filter { $0.source == .chat }.sorted { $0.updatedAt > $1.updatedAt } }
            .receive(on: DispatchQueue.main)
            .assign(to: &$conversations)
    }

    convenience init(store: ConversationStore) {
        self.init(
            conversations: store.$conversations.eraseToAnyPublisher(),
            reload: { [weak store] in store?.loadAll() },
            delete: { [weak store] id in store?.delete(id: id) }
        )
    }

    func sections(matching query: String) -> [DrawerSection] {
        let rows = Self.filter(conversations, query: query).map(Self.row)
        return DrawerRecency.sections(rows, now: now(), calendar: calendar)
    }

    func reload() { reloadAction() }

    func delete(id: String) {
        deleteAction(id)
        conversations.removeAll { $0.id == id }
    }

    // MARK: - Mapping (pure, tested)

    /// Case-insensitive match on the title or any message (the old history sheet's search).
    static func filter(_ conversations: [Conversation], query: String) -> [Conversation] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return conversations }
        return conversations.filter {
            $0.title.lowercased().contains(q) || $0.messages.contains { $0.content.lowercased().contains(q) }
        }
    }

    /// Title, a one-line preview of the latest message, and when it was last updated.
    static func row(_ conversation: Conversation) -> DrawerRow {
        let preview = conversation.messages.last.map { msg -> String in
            let oneLine = msg.content
                .components(separatedBy: .newlines)
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            return String(oneLine.prefix(80))
        }
        return DrawerRow(
            id: conversation.id,
            title: conversation.title,
            subtitle: preview?.isEmpty == false ? preview : nil,
            date: conversation.updatedAt
        )
    }
}
