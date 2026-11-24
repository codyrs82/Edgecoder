import Foundation

/// The on-device chat's network fallback (ChatRouter step 3, SwarmRuntimeController.submitChatTask):
/// a model call on the coordinator, the same one the desktop app makes (src/apps/ide/network-inference.ts).
///
/// 1. POST /inference/submit { taskId, submitterAccountId, model, messages, maxTokens, source }, signed
///    with the agent key; the coordinator bills the signing agent's owner. Answer: { taskId, subtaskId, ... }.
/// 2. POST /inference/stream { taskId, subtaskId, after, waitMs } (a long poll) until `done`; each answer
///    carries { chunks, next, done, error?, creditsSpent? } and the reply is the chunks joined.
///
/// (It used to POST /tasks, which the coordinator does not serve, so the fallback always failed.
/// /submit is the code-task pipeline: it needs a snapshotRef and splits the prompt into code subtasks.)
enum SwarmChatProtocol {
    static let submitPath = "/inference/submit"
    static let streamPath = "/inference/stream"
    /// No model chosen: the coordinator's best-fit routing picks one (AUTO_MODEL_ID).
    static let autoModel = "auto"
    static let maxTokens = 512
    static let source = "EdgeCoder iOS chat"
    /// How long one stream read waits for something new (the coordinator allows up to 25 s).
    static let streamWaitMs = 15_000
    /// A whole call: the coordinator's default call timeout (180 s) plus time to be picked up.
    static let deadlineSeconds: TimeInterval = 240

    struct Message: Equatable {
        let role: String
        let content: String
    }

    static func newTaskId() -> String {
        "ios-chat-\(UUID().uuidString.lowercased())"
    }

    static func submitBody(taskId: String, agentId: String, messages: [Message], requestedModel: String?) -> [String: Any] {
        let model = requestedModel.flatMap { $0.isEmpty ? nil : $0 } ?? autoModel
        return [
            "taskId": taskId,
            // The signing agent: the coordinator bills its owner's account.
            "submitterAccountId": agentId,
            "model": model,
            "messages": messages.map { ["role": $0.role, "content": $0.content] },
            "maxTokens": maxTokens,
            "source": source
        ]
    }

    /// The subtask to read the reply from, or nil when the answer has none.
    static func subtaskId(fromSubmit response: [String: Any]) -> String? {
        guard let id = response["subtaskId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    static func streamBody(taskId: String, subtaskId: String, after: Int) -> [String: Any] {
        ["taskId": taskId, "subtaskId": subtaskId, "after": after, "waitMs": streamWaitMs]
    }

    struct StreamPage: Equatable {
        /// The new pieces of the reply, joined.
        let text: String
        /// The `after` for the next read.
        let next: Int
        let done: Bool
        let error: String?
        /// What the call cost (cSats), on the last read.
        let creditsSpent: Double?
    }

    /// One /inference/stream answer, or nil when it is not one.
    static func streamPage(_ response: [String: Any], after: Int) -> StreamPage? {
        guard let chunks = response["chunks"] as? [String] else { return nil }
        let next = (response["next"] as? NSNumber)?.intValue ?? (after + chunks.count)
        let error = (response["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return StreamPage(
            text: chunks.joined(),
            next: next,
            done: response["done"] as? Bool ?? false,
            error: error,
            creditsSpent: (response["creditsSpent"] as? NSNumber)?.doubleValue
        )
    }
}
