import XCTest

/// The App Store screenshot sample data (`-screenshotFixture`, Debug only) decodes into the real
/// types, so a model change can't leave a screenshot tab silently empty.
final class ScreenshotFixtureTests: XCTestCase {
    func testOffWithoutTheLaunchArgument() {
        XCTAssertFalse(ScreenshotFixture.isEnabled)
    }

    func testWalletDecodes() throws {
        let w = try XCTUnwrap(ScreenshotFixture.wallet)
        XCTAssertEqual(w.network, "bitcoin")
        XCTAssertEqual(w.cSats, ScreenshotFixture.cSats)
        XCTAssertFalse(w.recent.isEmpty)
        XCTAssertNotNil(w.payouts?.balance)
    }

    func testBotsAndMachinesDecodeAndJoin() throws {
        let bots = try XCTUnwrap(ScreenshotFixture.bots)
        XCTAssertTrue(bots.bots.contains { !($0.pending ?? []).isEmpty })
        XCTAssertEqual(bots.cloudBots.count, 1)
        let rows = MachinesDirectory.rows(machines: try XCTUnwrap(ScreenshotFixture.machines), bots: bots)
        XCTAssertEqual(rows.map(\.name), ["lambda-a100-gpu0", "Mac Studio", "MacBook Pro"])
        XCTAssertEqual(rows.filter(\.online).count, 2)
        XCTAssertTrue(rows.allSatisfy { $0.model != nil })
    }

    func testChatAnswerHasCodeAndAFreeOwnMachineFooter() throws {
        let c = ScreenshotFixture.conversation
        XCTAssertEqual(c.messages.map(\.role), [.user, .assistant])
        XCTAssertTrue(c.messages[1].content.contains("```swift"))
        let footer = try XCTUnwrap(c.messages[1].footer)
        XCTAssertTrue(footer.hasPrefix("qwen3-coder:30b · "), footer)
        XCTAssertTrue(footer.contains("your machine"), footer)
        XCTAssertTrue(footer.hasSuffix("free"), footer)
    }
}
