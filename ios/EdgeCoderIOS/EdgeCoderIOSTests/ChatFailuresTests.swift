import XCTest

/// The Swift port must word failures exactly as src/common/chat-failures.ts and the web chat do
/// (expected values come from running the TypeScript).
final class ChatFailuresTests: XCTestCase {
    func testFailureKindsMatchTypeScript() {
        let cases: [(String, ChatFailureKind, String)] = [
            ("Not enough cSats: this call costs up to 12.5 cSats", .csats, "Couldn't run: out of cSats"),
            ("Your budget is spent for today", .budget, "Couldn't run: today's budget is spent"),
            ("No GPU machines online", .class, "Couldn't run: no machines of that class online"),
            ("The agent isn't connected", .offline, "Couldn't run: offline"),
            ("no model is installed", .model, "Couldn't run: no model available"),
            ("boom", .other, "Couldn't run"),
            ("costs more than the 5 cSats ceiling", .csats, "Couldn't run: out of cSats"),
        ]
        for (message, kind, line) in cases {
            XCTAssertEqual(ChatFailures.kind(message), kind, message)
            XCTAssertEqual(ChatFailures.line(kind), line)
        }
    }

    func testOutOfCSatsCodeAndPaymentRequiredWin() {
        XCTAssertEqual(ChatFailures.kind(message: "anything", code: "out_of_csats", httpStatus: 200), .csats)
        XCTAssertEqual(ChatFailures.kind(message: "anything", code: nil, httpStatus: 402), .csats)
        XCTAssertEqual(ChatFailures.kind(message: "isn't running", code: nil, httpStatus: 502), .offline)
    }

    func testFailureInfoForOutOfCSats() {
        let f = ChatFailureInfo(message: "Not enough cSats: this chat sets aside up to 12.5 cSats", code: "out_of_csats", httpStatus: 402, retryText: "hi")
        XCTAssertEqual(f.headline, "Couldn't run: out of cSats")
        XCTAssertEqual(f.detail, "This chat sets aside up to 12.5 cSats; unused cSats come back.")
        XCTAssertTrue(f.offersBuy)
        XCTAssertEqual(f.retryText, "hi")
    }

    func testOtherFailureShowsPlainErrorText() {
        let f = ChatFailureInfo(message: "all_coordinators_failed", retryText: nil)
        XCTAssertEqual(f.kind, .other)
        XCTAssertEqual(f.headline, "EdgeCoder's model didn't answer. Try again in a moment.")
        XCTAssertEqual(f.detail, "")
        XCTAssertFalse(f.offersBuy)
        XCTAssertEqual(ChatFailures.errorText("The network connection was lost."), "The connection to EdgeCoder dropped before the reply arrived.")
        XCTAssertEqual(ChatFailures.errorText(""), "Something went wrong.")
    }

    func testLooksTruncated() {
        XCTAssertFalse(ChatFailures.looksTruncated("Done."))
        XCTAssertFalse(ChatFailures.looksTruncated("All good!  \n"))
        XCTAssertTrue(ChatFailures.looksTruncated("and then the"))
        XCTAssertTrue(ChatFailures.looksTruncated("```swift\nlet x = 1."))
        XCTAssertFalse(ChatFailures.looksTruncated(""))
    }

    func testReplyFooter() {
        XCTAssertEqual(ChatFailures.formatCSats(3.4), "3.4 cSats")
        XCTAssertEqual(ChatFailures.formatCSats(0.00421), "0.0042 cSats")
        XCTAssertEqual(ChatFailures.formatCSats(1234.6), "1,235 cSats")
        XCTAssertEqual(ChatFailures.replyFooter(cSatsSpent: 3.4, compute: "Network · best fit"), "3.4 cSats \u{00B7} Network · best fit")
        XCTAssertEqual(ChatFailures.replyFooter(cSatsSpent: nil, compute: "My machines · qwen2.5-coder:7b"), "My machines · qwen2.5-coder:7b")
        XCTAssertNil(ChatFailures.replyFooter(cSatsSpent: nil, compute: nil))
    }
}
