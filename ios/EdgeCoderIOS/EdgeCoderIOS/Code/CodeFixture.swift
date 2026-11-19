import Foundation

/// Sample computers, a running session and a turn's changes for previews, tests and screenshots:
/// launch a Debug build with `-codeFixture` and Code mode reads these instead of the portal (no
/// sign-in). `-codeScreen projects|session|diff` opens straight on that screen. Release builds never use it.
enum CodeFixture {
    static var isEnabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-codeFixture")
        #else
        return false
        #endif
    }

    /// `-codeScreen <name>` (Debug only).
    static var startScreen: String? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard isEnabled, let i = args.firstIndex(of: "-codeScreen"), i + 1 < args.count else { return nil }
        return args[i + 1]
        #else
        return nil
        #endif
    }

    static let agentId = "agent-mbp-7f3a"
    static let sessionId = "3f1c2a4e-8b7d-4c1e-9a2f-5d6e7f8a9b0c"
    static let turnId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

    static var machines: [CodeMachine] {
        (try? JSONDecoder().decode(CodeMachinesResponse.self, from: Data(recent(machinesJSON).utf8)))?.machines ?? []
    }

    static var snapshot: CodeJSON {
        (try? JSONDecoder().decode(CodeJSON.self, from: Data(recent(snapshotJSON).utf8))) ?? .null
    }

    /// The fixtures' times are around this; screenshots show them as minutes ago.
    static let fixtureNowMs: Double = 1_763_460_000_000

    /// `json` with every millisecond time (17xxxxxxxxxxx) moved by now - `fixtureNowMs`.
    static func recent(_ json: String, now: Date = Date()) -> String {
        let shift = now.timeIntervalSince1970 * 1000 - fixtureNowMs
        guard let re = try? NSRegularExpression(pattern: #"\b17\d{11}\b"#) else { return json }
        var out = json
        for m in re.matches(in: json, range: NSRange(json.startIndex..., in: json)).reversed() {
            guard let r = Range(m.range, in: out), let v = Double(out[r]) else { continue }
            out.replaceSubrange(r, with: String(Int64(v + shift)))
        }
        return out
    }

    static var changes: CodeJSON {
        (try? JSONDecoder().decode(CodeJSON.self, from: Data(changesJSON.utf8))) ?? .null
    }

    /// Shaped like GET /portal/api/code/machines.
    static let machinesJSON = #"""
    {"machines":[
      {"agentId":"agent-mbp-7f3a","name":"Cody's MacBook Pro","online":true,"controls":"on","updatedAtMs":1763460000000,
       "projects":[
         {"projectId":"0a1b2c3d4e5f6a7b","name":"Edgecoder","parent":"Claude","branch":"ios-code-mode"},
         {"projectId":"1b2c3d4e5f6a7b8c","name":"portfolio-site","parent":"Projects","branch":"main"},
         {"projectId":"2c3d4e5f6a7b8c9d","name":"scripts","parent":"codysmith"}
       ],
       "sessions":[
         {"sessionId":"3f1c2a4e-8b7d-4c1e-9a2f-5d6e7f8a9b0c","projectId":"0a1b2c3d4e5f6a7b","title":"Fix flaky wallet test","status":"waiting","updatedAtMs":1763459940000,"pendingApprovals":1,"startedFrom":"phone"},
         {"sessionId":"4a2d3b5f-9c8e-4d2f-8b3a-6e7f8a9b0c1d","projectId":"0a1b2c3d4e5f6a7b","title":"Add dark mode to settings","status":"idle","updatedAtMs":1763380000000,"pendingApprovals":0,"startedFrom":"mac"},
         {"sessionId":"5b3e4c6a-0d9f-4e3a-9c4b-7f8a9b0c1d2e","projectId":"1b2c3d4e5f6a7b8c","title":"Update the hero image","status":"running","updatedAtMs":1763459000000,"pendingApprovals":0,"startedFrom":"phone"}
       ]},
      {"agentId":"agent-studio-21c9","name":"Mac Studio","online":true,"controls":"view","updatedAtMs":1763459000000,
       "projects":[{"projectId":"3d4e5f6a7b8c9d0e","name":"ml-pipeline","parent":"work"}],
       "sessions":[{"sessionId":"6c4f5d7b-1e0a-4f4b-8d5c-8a9b0c1d2e3f","projectId":"3d4e5f6a7b8c9d0e","title":"Speed up the tokenizer","status":"idle","updatedAtMs":1763300000000,"pendingApprovals":0,"startedFrom":"mac"}]},
      {"agentId":"agent-mini-0b44","name":"Mac mini","online":true,"controls":"off","projects":[],"sessions":[]},
      {"agentId":"agent-air-5e12","name":"MacBook Air","online":false,"controls":"on","projects":[],"sessions":[],"somethingNew":42}
    ]}
    """#

    /// Shaped like code-remote.ts remoteSessionSnapshot (the Mac's `data` for "snapshot").
    static let snapshotJSON = #"""
    {"session":{"id":"3f1c2a4e-8b7d-4c1e-9a2f-5d6e7f8a9b0c","title":"Fix flaky wallet test","projectId":"0a1b2c3d4e5f6a7b","projectName":"Edgecoder","branch":"ios-code-mode","model":"claude-sonnet","mode":"ask","origin":"remote","published":true,"running":true,"pending":1,"queued":0,"messages":4,"cSats":12.5,"createdAt":1763459000000,"updatedAt":1763459940000},
     "seq":42,
     "running":{"turnId":"b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e","text":"The test fails because the clock isn't frozen. I'll run the suite to confirm the fix.","steps":[
        {"tool":"read_file","detail":"<project>/src/wallet/ledger.test.ts","status":"ok"},
        {"tool":"edit_file","detail":"<project>/src/wallet/ledger.test.ts","status":"ok"},
        {"tool":"run_shell","detail":"npm test -- ledger","status":"pending"}]},
     "pending":[{"callId":"call_9","tool":"run_shell","detail":"npm test -- ledger","command":"npm test -- src/wallet/ledger.test.ts --reporter=verbose","approvable":true}],
     "queue":[],
     "tail":[
       {"id":"m1","role":"note","content":"Started from iPhone","at":1763459000000},
       {"id":"m2","role":"user","content":"The wallet ledger test fails about one run in five. Find out why and fix it.","at":1763459010000,"by":"remote"},
       {"id":"m3","role":"assistant","content":"The test compares **timestamps** made a few milliseconds apart, so it fails when a run crosses a second boundary.\n\nI froze the clock with `vi.useFakeTimers()` in `ledger.test.ts`.","at":1763459600000,"turnId":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d","changedFiles":["<project>/src/wallet/ledger.test.ts"],"steps":[
          {"tool":"grep","detail":"Date.now","status":"ok"},
          {"tool":"read_file","detail":"<project>/src/wallet/ledger.test.ts","status":"ok"},
          {"tool":"edit_file","detail":"<project>/src/wallet/ledger.test.ts","status":"ok"}]},
       {"id":"m4","role":"user","content":"Run the tests to make sure.","at":1763459900000,"by":"remote"}
     ]}
    """#

    /// Shaped like code-remote.ts "changes" (fitList: { items, total }).
    static let changesJSON = #"""
    {"items":[
      {"path":"<project>/src/wallet/ledger.test.ts","before":"import { describe, it, expect } from \"vitest\";\nimport { Ledger } from \"./ledger\";\n\ndescribe(\"Ledger\", () => {\n  it(\"stamps entries\", () => {\n    const l = new Ledger();\n    const a = l.add(5);\n    const b = l.add(7);\n    expect(b.at - a.at).toBe(0);\n  });\n});\n","after":"import { describe, it, expect, vi, beforeEach, afterEach } from \"vitest\";\nimport { Ledger } from \"./ledger\";\n\ndescribe(\"Ledger\", () => {\n  beforeEach(() => vi.useFakeTimers({ now: 1_700_000_000_000 }));\n  afterEach(() => vi.useRealTimers());\n\n  it(\"stamps entries\", () => {\n    const l = new Ledger();\n    const a = l.add(5);\n    const b = l.add(7);\n    expect(b.at - a.at).toBe(0);\n  });\n});\n"},
      {"path":"<project>/docs/testing.md","before":null,"after":"# Testing\n\nTests that read the clock freeze it with vi.useFakeTimers().\n"}
     ],"total":2}
    """#
}

/// Canned answers for `-codeFixture`: every write succeeds and changes nothing.
final class CodeFixtureBackend: CodeBackend {
    static let shared = CodeFixtureBackend()

    func machines() async throws -> [CodeMachine] {
        try await Task.sleep(nanoseconds: 150_000_000)
        return CodeFixture.machines
    }

    func run(agentId: String, action: String, args: [String: CodeJSON]) async throws -> CodeJSON {
        try await Task.sleep(nanoseconds: 150_000_000)
        switch action {
        case "snapshot": return CodeFixture.snapshot
        case "changes": return CodeFixture.changes
        case "messages": return .object(["items": .array([]), "more": .bool(false)])
        case "create": return .object(["sessionId": .string(CodeFixture.sessionId)])
        default: return .object([:])
        }
    }
}
