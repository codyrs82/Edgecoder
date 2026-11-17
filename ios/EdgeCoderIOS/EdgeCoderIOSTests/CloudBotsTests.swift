import XCTest

/// Cloud bots: POST /portal/api/bots/new bodies, GET /portal/api/bots with and without cloud
/// fields, and the daily schedule's local-to-UTC conversion.
final class CloudBotsTests: XCTestCase {
    private func json(_ value: Encodable) throws -> [String: Any] {
        let enc = JSONEncoder()
        enc.outputFormatting = .sortedKeys
        let data = try enc.encode(AnyEnc(value))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private struct AnyEnc: Encodable {
        let v: Encodable
        init(_ v: Encodable) { self.v = v }
        func encode(to encoder: Encoder) throws { try v.encode(to: encoder) }
    }
    private func bot(_ spec: NewBotRequest.Spec, agentId: String? = "cloud") throws -> [String: Any] {
        let body = try json(NewBotRequest(requestId: "req-12345678", agentId: agentId, bot: spec))
        return try XCTUnwrap(body["bot"] as? [String: Any])
    }
    private let ny = TimeZone(identifier: "America/New_York")!
    /// 2026-01-15 12:00 UTC (winter: New York is UTC-5).
    private let winter = Date(timeIntervalSince1970: 1_768_478_400)
    /// 2026-07-15 12:00 UTC (summer: New York is UTC-4).
    private let summer = Date(timeIntervalSince1970: 1_784_116_800)

    // MARK: request encoding

    func testDefaultsAreLeftOut() throws {
        let body = try json(NewBotRequest(requestId: "req-12345678", agentId: "cloud", bot: .init(name: "Docs", role: "Writer", instructions: "Keep docs fresh")))
        XCTAssertEqual(body["requestId"] as? String, "req-12345678")
        XCTAssertEqual(body["agentId"] as? String, "cloud")
        let b = try XCTUnwrap(body["bot"] as? [String: Any])
        XCTAssertEqual(Set(b.keys), ["name", "role", "instructions"])
        XCTAssertEqual(b["name"] as? String, "Docs")
        XCTAssertEqual(b["role"] as? String, "Writer")
        XCTAssertEqual(b["instructions"] as? String, "Keep docs fresh")
    }

    func testFirstMachineAvailableSendsNullAgent() throws {
        let body = try json(NewBotRequest(requestId: "req-12345678", agentId: nil, bot: .init(name: "A", role: "", instructions: "")))
        XCTAssertTrue(body["agentId"] is NSNull)
        let m = try json(NewBotRequest(requestId: "req-12345678", agentId: "agent-mac", bot: .init(name: "A", role: "", instructions: "")))
        XCTAssertEqual(m["agentId"] as? String, "agent-mac")
    }

    func testComputeChoices() throws {
        XCTAssertNil(try bot(.init(name: "A", role: "", instructions: "", model: .auto))["compute"])
        let mine = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", model: .mine("qwen3.5:9b")))["compute"] as? [String: String])
        XCTAssertEqual(mine, ["target": "mine", "model": "qwen3.5:9b"])
        let net = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", model: .network("llama3.3:70b")))["compute"] as? [String: String])
        XCTAssertEqual(net, ["target": "network", "model": "llama3.3:70b"])
    }

    func testWebToggle() throws {
        XCTAssertNil(try bot(.init(name: "A", role: "", instructions: "", web: true))["web"])
        XCTAssertEqual(try bot(.init(name: "A", role: "", instructions: "", web: false))["web"] as? Bool, false)
    }

    func testSchedules() throws {
        XCTAssertNil(try bot(.init(name: "A", role: "", instructions: "", schedule: .none))["schedule"])
        let every = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", schedule: .everyHours(6)))["schedule"] as? [String: Int])
        XCTAssertEqual(every, ["everyMinutes": 360])
        let daily = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", schedule: .daily(hour: 9, minute: 30), timeZone: ny, now: winter))["schedule"] as? [String: String])
        XCTAssertEqual(daily, ["dailyAtUtc": "14:30"])
    }

    func testGitHubWithEveryTrigger() throws {
        let gh = NewBotRequest.GitHub(repo: "codyrs82/Edgecoder", token: "ghp_secret", triggers: [.prOpened, .ciFailed, .issueLabeled("bot")])
        let g = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", github: gh))["github"] as? [String: Any])
        XCTAssertEqual(g["repo"] as? String, "codyrs82/Edgecoder")
        XCTAssertEqual(g["token"] as? String, "ghp_secret")
        let triggers = try XCTUnwrap(g["triggers"] as? [[String: String]])
        XCTAssertEqual(triggers, [["kind": "pr_opened"], ["kind": "ci_failed"], ["kind": "issue_labeled", "label": "bot"]])
    }

    func testGitHubWithoutTokenOrTriggers() throws {
        let gh = NewBotRequest.GitHub(repo: "o/r", token: nil, triggers: [])
        let g = try XCTUnwrap(try bot(.init(name: "A", role: "", instructions: "", github: gh))["github"] as? [String: Any])
        XCTAssertNil(g["token"])
        XCTAssertEqual((g["triggers"] as? [Any])?.count, 0)
        let empty = NewBotRequest.GitHub(repo: "o/r", token: "", triggers: [])
        XCTAssertNil((try bot(.init(name: "A", role: "", instructions: "", github: empty))["github"] as? [String: Any])?["token"])
    }

    func testEveryOptionTogether() throws {
        let gh = NewBotRequest.GitHub(repo: "o/r", token: nil, triggers: [.ciFailed])
        let b = try bot(.init(name: "All", role: "R", instructions: "I", model: .network("m"), web: false, schedule: .everyHours(1), github: gh))
        XCTAssertEqual(Set(b.keys), ["name", "role", "instructions", "compute", "web", "schedule", "github"])
    }

    func testRepoNormalizing() {
        XCTAssertEqual(BotSchedule.normalizeRepo("codyrs82/Edgecoder"), "codyrs82/Edgecoder")
        XCTAssertEqual(BotSchedule.normalizeRepo(" https://github.com/codyrs82/Edgecoder.git/ "), "codyrs82/Edgecoder")
        XCTAssertEqual(BotSchedule.normalizeRepo("github.com/a-b/c_d.e"), "a-b/c_d.e")
        XCTAssertNil(BotSchedule.normalizeRepo(""))
        XCTAssertNil(BotSchedule.normalizeRepo("justone"))
        XCTAssertNil(BotSchedule.normalizeRepo("a/b/c"))
        XCTAssertNil(BotSchedule.normalizeRepo("a b/c"))
    }

    // MARK: UTC schedule conversion

    func testUtcConversion() {
        XCTAssertEqual(BotSchedule.utcTime(hour: 9, minute: 0, in: ny, on: winter), "14:00")
        XCTAssertEqual(BotSchedule.utcTime(hour: 9, minute: 0, in: ny, on: summer), "13:00")
        // Past midnight UTC wraps to the next day's time.
        XCTAssertEqual(BotSchedule.utcTime(hour: 22, minute: 15, in: ny, on: winter), "03:15")
        // East of UTC wraps back.
        XCTAssertEqual(BotSchedule.utcTime(hour: 2, minute: 0, in: TimeZone(identifier: "Asia/Tokyo")!, on: winter), "17:00")
        // Half-hour zone.
        XCTAssertEqual(BotSchedule.utcTime(hour: 8, minute: 0, in: TimeZone(identifier: "Asia/Kolkata")!, on: summer), "02:30")
        XCTAssertEqual(BotSchedule.utcTime(hour: 0, minute: 5, in: TimeZone(identifier: "UTC")!, on: summer), "00:05")
    }

    // MARK: parsing

    private let cloudListJSON = #"""
    {"machines":[{"agentId":"agent-mac","machineName":"Studio","online":true,"controls":"on"}],
     "bots":[
       {"id":"b1","name":"Docs","status":"idle","enabled":true,"machine":{"agentId":"agent-mac","machineName":"Studio","online":true,"controls":"on"}},
       {"id":"c1","name":"Triage","status":"idle","enabled":true,"runtime":"cloud","agentId":"cloud","schedule":"Daily 14:00 UTC","futureField":{"x":1}},
       {"id":"c2","name":"Release","status":"paused","enabled":false,"runtime":"cloud","agentId":"cloud",
        "machine":{"agentId":"cloud","machineName":"Cloud","online":true,"controls":"on"}}
     ],
     "pending":[],
     "targets":[{"agentId":"cloud","machineName":"Cloud","online":true,"canCreate":true},
                {"agentId":"agent-mac","machineName":"Studio","online":true,"canCreate":true},
                {"agentId":"agent-old","machineName":"Old","online":false,"canCreate":false}],
     "canCreate":true}
    """#

    func testParsesCloudBotsAndTargets() throws {
        let r = try JSONDecoder().decode(BotsListResponse.self, from: Data(cloudListJSON.utf8))
        XCTAssertEqual(r.bots.count, 3)
        XCTAssertEqual(r.cloudBots.map(\.botId), ["c1", "c2"])
        XCTAssertFalse(r.bots[0].isCloud)
        XCTAssertEqual(r.bots[0].hostAgentId, "agent-mac")
        XCTAssertEqual(r.bots[1].hostAgentId, "cloud")
        XCTAssertEqual(r.bots[1].id, "cloud/c1")
        XCTAssertTrue(r.bots[2].isPaused)
        XCTAssertEqual(r.cloudTarget?.machineName, "Cloud")
        XCTAssertEqual(r.machineTargets.map(\.agentId), ["agent-mac"])
        XCTAssertEqual(r.createTargets.map(\.agentId), ["cloud", "agent-mac"])
    }

    func testCloudTargetEvenWithoutMachineHolding() throws {
        let j = #"{"machines":[],"bots":[],"targets":[{"agentId":"cloud","machineName":"Cloud","online":true,"canCreate":true}]}"#
        let r = try JSONDecoder().decode(BotsListResponse.self, from: Data(j.utf8))
        XCTAssertEqual(r.createTargets.map(\.agentId), ["cloud"])
    }

    func testOldResponseWithoutCloudFields() throws {
        let old = #"""
        {"machines":[{"agentId":"agent-mac","machineName":"Studio","online":true,"controls":"on","reportedAtMs":1}],
         "bots":[{"id":"b1","name":"Docs","status":"running","activity":"editing","enabled":true,
                  "machine":{"agentId":"agent-mac","machineName":"Studio","online":true,"controls":"on"}}],
         "targets":[{"agentId":"agent-mac","machineName":"Studio","online":true,"canCreate":true}],
         "canCreate":true}
        """#
        let r = try JSONDecoder().decode(BotsListResponse.self, from: Data(old.utf8))
        XCTAssertNil(r.cloudTarget)
        XCTAssertTrue(r.cloudBots.isEmpty)
        XCTAssertNil(r.bots[0].runtime)
        XCTAssertEqual(r.bots[0].id, "agent-mac/b1")
        XCTAssertEqual(r.createTargets.map(\.agentId), ["agent-mac"])
        // Older still: no targets, no canCreate.
        let oldest = try JSONDecoder().decode(BotsListResponse.self, from: Data(#"{"machines":[],"bots":[]}"#.utf8))
        XCTAssertNil(oldest.cloudTarget)
        XCTAssertTrue(oldest.createTargets.isEmpty)
        // A portal that can't hold machine bots: machines aren't offered.
        let noHold = try JSONDecoder().decode(BotsListResponse.self, from: Data(#"{"machines":[],"bots":[],"targets":[{"agentId":"a","machineName":"A","online":true}]}"#.utf8))
        XCTAssertTrue(noHold.machineTargets.isEmpty)
    }

    func testCloudDetailWithoutMachine() throws {
        let j = #"""
        {"bot":{"id":"c1","name":"Triage","status":"idle","enabled":true,"runtime":"cloud",
                "tail":[{"id":"m1","role":"user","content":"hi","atMs":1},{"id":"m2","role":"assistant","content":"hello","atMs":2,"steps":[]}]}}
        """#
        let r = try JSONDecoder().decode(BotDetailResponse.self, from: Data(j.utf8))
        XCTAssertNil(r.machine)
        XCTAssertTrue(r.bot.isCloud)
        XCTAssertEqual(r.bot.tail?.last?.content, "hello")
    }

    func testCreateAndCommandAnswers() throws {
        let cloud = try JSONDecoder().decode(BotCommandResponse.self, from: Data(#"{"botId":"c9","agentId":"cloud"}"#.utf8))
        XCTAssertTrue(cloud.accepted)
        let machine = try JSONDecoder().decode(BotCommandResponse.self, from: Data(#"{"ok":true,"botId":"bot_w1","state":"waiting"}"#.utf8))
        XCTAssertTrue(machine.accepted)
        let cmd = try JSONDecoder().decode(BotCommandResponse.self, from: Data(#"{"commandId":"cmd-123456789"}"#.utf8))
        XCTAssertTrue(cmd.accepted)
        let refused = try JSONDecoder().decode(BotCommandResponse.self, from: Data(#"{"error":"invalid_bot","message":"bad"}"#.utf8))
        XCTAssertFalse(refused.accepted)
        XCTAssertFalse(BotsFormat.commandError("too_many_pending", message: "At most 5 new bots can wait for a Mac.").contains("Mac"))
    }

    func testCommandStates() throws {
        let done = try JSONDecoder().decode(BotCommandState.self, from: Data(#"{"status":"answered","result":{"status":"done"}}"#.utf8))
        XCTAssertTrue(done.isFinished); XCTAssertFalse(done.failed)
        let queued = try JSONDecoder().decode(BotCommandState.self, from: Data(#"{"status":"queued"}"#.utf8))
        XCTAssertFalse(queued.isFinished)
        let failed = try JSONDecoder().decode(BotCommandState.self, from: Data(#"{"status":"failed","error":"x"}"#.utf8))
        XCTAssertTrue(failed.failed)
    }

    func testComputeOptionsToModelChoices() throws {
        let j = #"""
        {"connected":true,"options":[
          {"id":"reserved:m:any:r1","group":"reserved","label":"x","detail":"","compute":{"target":"reserved","model":"m","reservationId":"r1"}},
          {"id":"network:big:any:","group":"network","label":"x","detail":"","compute":{"target":"network","model":"big","computeClass":"any"}},
          {"id":"network:big:gpu:","group":"network","label":"x","detail":"","compute":{"target":"network","model":"big","computeClass":"gpu"}},
          {"id":"mine:small::","group":"mine","label":"x","detail":"","compute":{"target":"mine","model":"small"}}
        ]}
        """#
        let r = try JSONDecoder().decode(ComputeOptionsResponse.self, from: Data(j.utf8))
        XCTAssertEqual(r.modelChoices, [.auto, .mine("small"), .network("big")])
        XCTAssertEqual(r.modelChoices.map(\.label), ["Auto", "My machines · small", "Network · big"])
        let none = try JSONDecoder().decode(ComputeOptionsResponse.self, from: Data(#"{"options":[]}"#.utf8))
        XCTAssertEqual(none.modelChoices, [.auto])
    }
}
