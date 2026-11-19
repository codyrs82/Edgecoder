import Foundation

/// The Chat | Code switch at the top of the first tab. The last choice is kept in UserDefaults
/// (the view reads it with @AppStorage under the same key).
enum WorkspaceMode: String, CaseIterable, Identifiable {
    case chat, code

    static let storageKey = "edgecoder.firstTab.mode"
    static let defaultValue: WorkspaceMode = .chat

    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat: return "Chat"
        case .code: return "Code"
        }
    }

    /// Unknown or missing stored values fall back to Chat.
    static func load(from defaults: UserDefaults = .standard) -> WorkspaceMode {
        defaults.string(forKey: storageKey).flatMap(WorkspaceMode.init(rawValue:)) ?? defaultValue
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.storageKey)
    }
}

/// Wording shared by the Code placeholder screen and the drawer's Code list.
enum CodeCopy {
    static let emptyState = "Code sessions on your computers will show here. Turn on 'Code from your phone' in the EdgeCoder desktop app."
}

/// The drawer's Code list. A stub until the desktop pairing lands: no networking, always empty.
@MainActor
final class CodeDrawerSource: DrawerDataSource {
    @Published var selectedId: String?

    let title = "Code sessions"
    let newLabel: String? = nil
    let searchPrompt = "Search sessions"
    let emptyTitle = "No code sessions"
    let emptyMessage: String? = CodeCopy.emptyState
    let canDelete = false

    func sections(matching query: String) -> [DrawerSection] { [] }
    func reload() {}
    func delete(id: String) {}
}
