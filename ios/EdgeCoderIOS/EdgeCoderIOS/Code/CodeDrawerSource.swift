import Combine
import Foundation

/// The drawer's Code list: the sessions on your computers, one section per computer and project,
/// newest first. A row's id is "agentId/sessionId" (see `parse`).
@MainActor
final class CodeDrawerSource: DrawerDataSource {
    @Published private(set) var machines: [CodeMachine] = []
    @Published var selectedId: String?

    let title = "Code sessions"
    let newLabel: String? = "New session"
    let searchPrompt = "Search sessions"
    let emptyTitle = "No code sessions"
    let emptyMessage: String? = CodeCopy.emptyState
    let canDelete = false

    private let reloadAction: () -> Void

    init(machines: AnyPublisher<[CodeMachine], Never>, reload: @escaping () -> Void = {}) {
        self.reloadAction = reload
        machines
            .receive(on: DispatchQueue.main)
            .assign(to: &$machines)
    }

    convenience init(store: CodeStore) {
        self.init(
            machines: store.$machines.eraseToAnyPublisher(),
            reload: { [weak store] in store?.refreshInBackground() }
        )
    }

    func sections(matching query: String) -> [DrawerSection] {
        Self.sections(machines, query: query)
    }

    func reload() { reloadAction() }
    func delete(id: String) {}

    // MARK: - Mapping (pure, tested)

    static func rowId(agentId: String, sessionId: String) -> String { "\(agentId)/\(sessionId)" }

    /// (agentId, sessionId) from a row id; nil when it isn't one.
    static func parse(_ rowId: String) -> (agentId: String, sessionId: String)? {
        guard let slash = rowId.lastIndex(of: "/") else { return nil }
        let agent = String(rowId[..<slash]), session = String(rowId[rowId.index(after: slash)...])
        guard !agent.isEmpty, !session.isEmpty else { return nil }
        return (agent, session)
    }

    /// One section per computer and project ("MacBook Pro · Edgecoder"). Computers keep the
    /// portal's order; inside one, the project with the newest session comes first; sessions are
    /// newest first. A blank query lists everything; otherwise session, project or computer names
    /// containing it (case-insensitive).
    static func sections(_ machines: [CodeMachine], query: String) -> [DrawerSection] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var out: [DrawerSection] = []
        for m in machines {
            let byProject = Dictionary(grouping: m.sessions, by: \.projectId)
            let groups: [(projectId: String, name: String, sessions: [CodeSessionSummary])] = byProject.map { pid, sessions in
                (pid, m.project(pid)?.name ?? "Other project", sessions.sorted { $0.updatedAtMs > $1.updatedAtMs })
            }
            .sorted { a, b in
                let ta = a.sessions.first?.updatedAtMs ?? 0, tb = b.sessions.first?.updatedAtMs ?? 0
                return ta != tb ? ta > tb : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
            for g in groups {
                let heading = "\(m.name) · \(g.name)"
                let rows = g.sessions
                    .filter { q.isEmpty || $0.title.lowercased().contains(q) || heading.lowercased().contains(q) }
                    .map { s in
                        DrawerRow(
                            id: rowId(agentId: m.agentId, sessionId: s.sessionId),
                            title: s.title,
                            subtitle: m.online ? s.statusLine : "Offline",
                            date: s.updatedAtMs > 0 ? s.updatedAt : nil
                        )
                    }
                if !rows.isEmpty {
                    out.append(DrawerSection(id: "\(m.agentId)/\(g.projectId)", title: heading, rows: rows))
                }
            }
        }
        return out
    }
}
