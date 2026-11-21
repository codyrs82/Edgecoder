import Combine
import XCTest

/// PR4: the side drawer's state, the Chat drawer source, and the Chat | Code mode.
@MainActor
final class SideDrawerTests: XCTestCase {
    // MARK: - Drawer state

    func testOverlayOpensClosesAndToggles() {
        let s = SideDrawerState()
        XCTAssertFalse(s.isOpen)
        XCTAssertFalse(s.isShowing)
        s.open()
        XCTAssertTrue(s.isOpen)
        XCTAssertTrue(s.isShowing)
        s.close()
        XCTAssertFalse(s.isOpen)
        s.toggle()
        XCTAssertTrue(s.isOpen)
        s.toggle()
        XCTAssertFalse(s.isOpen)
    }

    func testSelectionClosesTheOverlay() {
        let s = SideDrawerState()
        s.open()
        s.didSelect()
        XCTAssertFalse(s.isOpen)
        XCTAssertFalse(s.isShowing)
    }

    func testPersistentSidebarStaysOpenOnSelectionAndToggles() {
        let s = SideDrawerState()
        s.isPersistent = true
        XCTAssertTrue(s.isShowing, "the iPad sidebar shows by default")
        s.didSelect()
        XCTAssertTrue(s.isShowing)
        s.toggle()
        XCTAssertFalse(s.isShowing)
        XCTAssertFalse(s.isOpen, "hiding the sidebar doesn't touch the overlay")
        s.open()
        XCTAssertTrue(s.isShowing)
    }

    // MARK: - Chat data source

    private let now = Date(timeIntervalSince1970: 1_763_400_000) // 2025-11-17 17:20 UTC
    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    /// Rows are compared by title (Conversation makes its own UUID ids).
    private func convo(_ title: String, hoursAgo: Double, source: Conversation.Source = .chat, messages: [String] = []) -> Conversation {
        var c = Conversation(source: source)
        c.title = title
        c.messages = messages.map { ChatMessage(role: .user, content: $0) }
        c.updatedAt = now.addingTimeInterval(-hoursAgo * 3600)
        return c
    }

    private func makeSource(_ conversations: [Conversation], deleted: @escaping (String) -> Void = { _ in }) -> ChatDrawerSource {
        let src = ChatDrawerSource(
            conversations: Just(conversations).eraseToAnyPublisher(),
            delete: deleted,
            now: { [now] in now },
            calendar: utc
        )
        // assign(to:) delivers on the main queue.
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        return src
    }

    func testMapsConversationsIntoRecencySections() {
        let src = makeSource([
            convo("Old one", hoursAgo: 24 * 45),
            convo("Fix the build", hoursAgo: 1, messages: ["why does\nxcodebuild fail", "it's the scheme"]),
            convo("Yesterday chat", hoursAgo: 24),
            convo("Earlier this week", hoursAgo: 24 * 4),
            convo("Last month", hoursAgo: 24 * 12),
            convo("An editor file", hoursAgo: 2, source: .editor),
        ])
        let sections = src.sections(matching: "")
        XCTAssertEqual(sections.map(\.title), ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"])
        XCTAssertEqual(sections.flatMap(\.rows).map(\.title),
                       ["Fix the build", "Yesterday chat", "Earlier this week", "Last month", "Old one"],
                       "chat conversations only, newest first")

        let row = sections[0].rows[0]
        XCTAssertEqual(row.title, "Fix the build")
        XCTAssertEqual(row.subtitle, "it's the scheme", "subtitle previews the latest message")
        XCTAssertEqual(row.date, now.addingTimeInterval(-3600))
        XCTAssertNil(sections[1].rows[0].subtitle, "no messages, no subtitle")
    }

    func testSearchFiltersByTitleOrMessageCaseInsensitively() {
        let src = makeSource([
            convo("Swift concurrency", hoursAgo: 1),
            convo("Dinner ideas", hoursAgo: 2, messages: ["something with SWIFTLY cooked pasta"]),
            convo("Rust lifetimes", hoursAgo: 3),
        ])
        XCTAssertEqual(src.sections(matching: "swift").flatMap(\.rows).map(\.title), ["Swift concurrency", "Dinner ideas"])
        XCTAssertEqual(src.sections(matching: "  RUST ").flatMap(\.rows).map(\.title), ["Rust lifetimes"])
        XCTAssertTrue(src.sections(matching: "kotlin").isEmpty)
        XCTAssertEqual(src.sections(matching: "   ").flatMap(\.rows).count, 3, "blank search shows everything")
    }

    func testDeleteRemovesTheRowAndCallsTheStore() {
        var deleted: [String] = []
        let a = convo("A", hoursAgo: 1)
        let src = makeSource([a, convo("B", hoursAgo: 2)], deleted: { deleted.append($0) })
        XCTAssertTrue(src.canDelete)
        src.delete(id: a.id)
        XCTAssertEqual(deleted, [a.id])
        XCTAssertEqual(src.sections(matching: "").flatMap(\.rows).map(\.title), ["B"])
    }

    func testCodeSourceStartsEmptyWithTheDesktopHint() {
        let src = CodeDrawerSource(machines: Just([]).eraseToAnyPublisher())
        XCTAssertTrue(src.sections(matching: "").isEmpty)
        XCTAssertFalse(src.canDelete)
        XCTAssertEqual(src.newLabel, "New session")
        XCTAssertEqual(src.emptyMessage, "Code sessions on your computers will show here. Turn on 'Code from your phone' in the EdgeCoder desktop app.")
    }

    // MARK: - Mode persistence

    func testModePersistsInUserDefaults() {
        let suite = "SideDrawerTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(WorkspaceMode.load(from: defaults), .chat, "Chat until something is chosen")
        WorkspaceMode.code.save(to: defaults)
        XCTAssertEqual(defaults.string(forKey: WorkspaceMode.storageKey), "code", "the raw value @AppStorage reads")
        XCTAssertEqual(WorkspaceMode.load(from: defaults), .code)
        WorkspaceMode.chat.save(to: defaults)
        XCTAssertEqual(WorkspaceMode.load(from: defaults), .chat)
        defaults.set("bogus", forKey: WorkspaceMode.storageKey)
        XCTAssertEqual(WorkspaceMode.load(from: defaults), .chat)
    }
}
