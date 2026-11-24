import UIKit
import XCTest

/// The chat's network fallback must speak the coordinator's model-call API
/// (src/swarm/coordinator/routes/inference.ts: inferenceSubmitSchema and /inference/stream).
final class SwarmChatProtocolTests: XCTestCase {
    func testUsesTheInferenceRoutesNotTasks() {
        XCTAssertEqual(SwarmChatProtocol.submitPath, "/inference/submit")
        XCTAssertEqual(SwarmChatProtocol.streamPath, "/inference/stream")
    }

    func testSubmitBodyMatchesTheInferenceSubmitSchema() throws {
        let body = SwarmChatProtocol.submitBody(
            taskId: "ios-chat-1",
            agentId: "iphone-abc123",
            messages: [.init(role: "user", content: "hi"), .init(role: "assistant", content: "hello"), .init(role: "user", content: "and?")],
            requestedModel: "qwen2.5-coder:7b"
        )
        XCTAssertEqual(body["taskId"] as? String, "ios-chat-1")
        XCTAssertEqual(body["submitterAccountId"] as? String, "iphone-abc123")
        XCTAssertEqual(body["model"] as? String, "qwen2.5-coder:7b")
        XCTAssertEqual(body["maxTokens"] as? Int, 512)
        XCTAssertEqual(body["source"] as? String, "EdgeCoder iOS chat")
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "user", "content": "hi"], ["role": "assistant", "content": "hello"], ["role": "user", "content": "and?"]])
        // None of the old /tasks fields, which the coordinator never read.
        for key in ["prompt", "language", "subtasks", "requestedModel", "projectId"] {
            XCTAssertNil(body[key], key)
        }
        XCTAssertTrue(JSONSerialization.isValidJSONObject(body))
    }

    func testNoModelChosenRoutesAuto() {
        for requested in [nil, ""] as [String?] {
            let body = SwarmChatProtocol.submitBody(taskId: "t", agentId: "a", messages: [.init(role: "user", content: "x")], requestedModel: requested)
            XCTAssertEqual(body["model"] as? String, "auto")
        }
    }

    func testTaskIdsAreUniqueAndWithinTheSchemaLimit() {
        let a = SwarmChatProtocol.newTaskId()
        let b = SwarmChatProtocol.newTaskId()
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.hasPrefix("ios-chat-"))
        XCTAssertLessThanOrEqual(a.count, 200)
    }

    func testSubtaskIdFromTheSubmitAnswer() {
        XCTAssertEqual(SwarmChatProtocol.subtaskId(fromSubmit: ["taskId": "t", "subtaskId": "s-1", "model": "m"]), "s-1")
        // The old code read `subtasks: [String]`, which /inference/submit does not return.
        XCTAssertNil(SwarmChatProtocol.subtaskId(fromSubmit: ["taskId": "t", "subtasks": ["s-1"]]))
        XCTAssertNil(SwarmChatProtocol.subtaskId(fromSubmit: ["subtaskId": ""]))
    }

    func testStreamBody() {
        let body = SwarmChatProtocol.streamBody(taskId: "t", subtaskId: "s", after: 3)
        XCTAssertEqual(body["taskId"] as? String, "t")
        XCTAssertEqual(body["subtaskId"] as? String, "s")
        XCTAssertEqual(body["after"] as? Int, 3)
        XCTAssertEqual(body["waitMs"] as? Int, 15_000)
    }

    func testStreamPagesFromCoordinatorJSON() throws {
        func decode(_ json: String) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        }
        let first = try XCTUnwrap(SwarmChatProtocol.streamPage(try decode(#"{"chunks":["Hel","lo"],"next":2,"done":false}"#), after: 0))
        XCTAssertEqual(first, .init(text: "Hello", next: 2, done: false, error: nil, creditsSpent: nil))

        let last = try XCTUnwrap(SwarmChatProtocol.streamPage(try decode(#"{"chunks":[" world"],"next":3,"done":true,"creditsSpent":1.25,"durationMs":900}"#), after: 2))
        XCTAssertEqual(last, .init(text: " world", next: 3, done: true, error: nil, creditsSpent: 1.25))

        let failed = try XCTUnwrap(SwarmChatProtocol.streamPage(try decode(#"{"chunks":[],"next":0,"done":true,"error":"agent_lost"}"#), after: 0))
        XCTAssertTrue(failed.done)
        XCTAssertEqual(failed.error, "agent_lost")

        XCTAssertNil(SwarmChatProtocol.streamPage(try decode(#"{"output":"old result shape"}"#), after: 0))
    }

    func testHostingOnlyOnExternalPower() {
        XCTAssertTrue(HostingPowerPolicy.mayHost(.charging))
        XCTAssertTrue(HostingPowerPolicy.mayHost(.full))
        XCTAssertFalse(HostingPowerPolicy.mayHost(.unplugged))
        XCTAssertFalse(HostingPowerPolicy.mayHost(.unknown))
    }
}
