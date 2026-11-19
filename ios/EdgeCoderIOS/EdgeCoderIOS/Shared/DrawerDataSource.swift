import Foundation

/// One line in the side drawer's list: a chat, or (later) a code session on one of your computers.
struct DrawerRow: Identifiable, Equatable {
    let id: String
    let title: String
    let subtitle: String?
    let date: Date?
}

/// A titled group of rows ("Today", "Yesterday", ...).
struct DrawerSection: Identifiable, Equatable {
    let id: String
    let title: String
    let rows: [DrawerRow]
}

/// What the side drawer lists. The drawer (ConversationSidebar) draws sections of rows, a search
/// field and a "New" button; the source decides what the rows are and whether they can be deleted.
@MainActor
protocol DrawerDataSource: ObservableObject {
    /// Heading at the top of the drawer ("Chats", "Code sessions").
    var title: String { get }
    /// The "New" button's label; nil hides the button.
    var newLabel: String? { get }
    var searchPrompt: String { get }
    /// Shown when the source has nothing at all (not when a search finds nothing).
    var emptyTitle: String { get }
    var emptyMessage: String? { get }
    var canDelete: Bool { get }
    /// The row that is open in the main view, highlighted in the list.
    var selectedId: String? { get }

    /// Rows matching the search text (empty or blank = everything), grouped into sections.
    func sections(matching query: String) -> [DrawerSection]
    /// Re-read from storage (the drawer calls this when it opens).
    func reload()
    func delete(id: String)
}

/// Groups dated items into the drawer's recency sections: Today, Yesterday, Previous 7 Days,
/// Previous 30 Days, Older. Items keep their order inside a section; empty sections are left out.
enum DrawerRecency {
    static let order = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"]

    static func bucket(for date: Date, now: Date, calendar: Calendar) -> String {
        let startOfToday = calendar.startOfDay(for: now)
        let startOfDay = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: startOfDay, to: startOfToday).day ?? 0
        switch days {
        case ..<1: return "Today"
        case 1: return "Yesterday"
        case 2..<7: return "Previous 7 Days"
        case 7..<30: return "Previous 30 Days"
        default: return "Older"
        }
    }

    static func sections(_ rows: [DrawerRow], now: Date = Date(), calendar: Calendar = .current) -> [DrawerSection] {
        var grouped: [String: [DrawerRow]] = [:]
        for row in rows {
            let key = row.date.map { bucket(for: $0, now: now, calendar: calendar) } ?? "Older"
            grouped[key, default: []].append(row)
        }
        return order.compactMap { key in
            guard let rows = grouped[key], !rows.isEmpty else { return nil }
            return DrawerSection(id: key, title: key, rows: rows)
        }
    }
}
