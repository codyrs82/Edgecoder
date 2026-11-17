import XCTest

/// Parsing of the portal's chat stream, wallet overview and bots answers.
final class PortalAPIParsingTests: XCTestCase {
    func testChatStreamEvents() {
        XCTAssertEqual(PortalChatParser.events(fromLine: ": keepalive"), [])
        XCTAssertEqual(PortalChatParser.events(fromLine: ""), [])
        XCTAssertEqual(PortalChatParser.events(fromLine: "data: [DONE]"), [.end])
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"content":"Hel"}"#), [.content("Hel")])
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"status":"Answering with EdgeCoder's own model (free, slower)..."}"#),
                       [.status("Answering with EdgeCoder's own model (free, slower)...")])
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"done":true,"compute":"Network · best fit","cSatsSpent":3.4}"#),
                       [.done(cSatsSpent: 3.4, compute: "Network · best fit", calls: nil)])
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"error":"Not enough cSats","code":"out_of_csats","httpStatus":402}"#),
                       [.error(message: "Not enough cSats", code: "out_of_csats", httpStatus: 402)])
        XCTAssertEqual(PortalChatParser.events(fromLine: "data: not json"), [])
    }

    func testChatRefusalBeforeStream() {
        let body = Data(#"{"error":"Not enough cSats: up to 8 cSats","code":"out_of_csats","compute":"Network · best fit"}"#.utf8)
        XCTAssertEqual(PortalChatParser.refusal(status: 402, body: body), .error(message: "Not enough cSats: up to 8 cSats", code: "out_of_csats", httpStatus: 402))
        XCTAssertEqual(PortalChatParser.refusal(status: 502, body: Data("Bad gateway".utf8)), .error(message: "Bad gateway", code: nil, httpStatus: 502))
        XCTAssertEqual(PortalChatParser.refusal(status: 500, body: Data()), .error(message: "Chat request failed: 500", code: nil, httpStatus: 500))
    }

    func testComputeJSON() {
        XCTAssertEqual(PortalChatCompute.auto.json, ["target": "auto"])
        XCTAssertEqual(PortalChatCompute.network(model: "qwen3.5:9b").json, ["target": "network", "model": "qwen3.5:9b"])
    }

    func testWalletOverviewWithLaunchCapsOnMainnet() throws {
        let json = #"""
        {"connected":true,"network":"bitcoin","networkSource":"coordinator","accountId":"acct-u1","cSats":1200.5,"earnedSats":3,
         "recent":[{"type":"spend","cSats":3.4,"reason":"inference:abc","atMs":1700000000000}],
         "btcUsd":90000,"rateAsOfMs":1,"rateStale":false,"fees":{"purchaseFeeBps":0,"networkFeeBps":500},
         "topup":{"minSats":100,"maxSats":1000000},
         "launch":{"mode":"invite","maxBuySatsPerDay":50000,"maxBalanceSats":100000,"maxPayoutSatsPerDay":20000,"boughtWindowSats":1000},
         "classes":{"gpu":{"label":"GPU","cSatsPerSecondBaseTier":0.2}},
         "models":[{"model":"qwen3.5:9b","agents":2,"classes":["gpu"],"cSatsPerMTokens":{"input":10,"output":40}}],
         "payouts":null}
        """#
        let o = try JSONDecoder().decode(WalletOverview.self, from: Data(json.utf8))
        XCTAssertEqual(o.network, "bitcoin")
        XCTAssertFalse(NetworkInfo(o.network).isTest)
        XCTAssertEqual(NetworkInfo(o.network).short, "mainnet")
        XCTAssertEqual(o.launch?.maxBuySatsPerDay, 50_000)
        XCTAssertEqual(BuyLimits.limit(launch: o.launch, balanceCSats: o.cSats, feeBps: o.fees.purchaseFeeBps).maxSats, 49_000)
        XCTAssertTrue(NetworkInfo("signet").isTest)
    }

    func testWalletOverviewWithoutLaunch() throws {
        let json = #"{"connected":false,"network":"signet","cSats":null,"recent":[],"fees":{"purchaseFeeBps":null,"networkFeeBps":null},"topup":{"minSats":100,"maxSats":1000000},"launch":null,"classes":{},"models":[],"payouts":null}"#
        let o = try JSONDecoder().decode(WalletOverview.self, from: Data(json.utf8))
        XCTAssertNil(o.launch)
        XCTAssertNil(o.cSats)
    }

    func testBotsList() throws {
        let json = #"""
        {"machines":[{"agentId":"agent-1","machineName":"MAW-MB-02","online":true,"controls":"on","reportedAtMs":1}],
         "bots":[{"id":"b1","name":"Reviewer","role":"PR review","color":"#5aa9ff","status":"idle","enabled":true,"folderName":"repo",
                  "schedule":"","heartbeatMinutes":null,"maxRunsPerDay":10,"runsToday":2,"runCount":40,"budgetCSatsPerDay":null,"spentTodayCSats":1.5,
                  "compute":{"policy":"auto"},"triggers":[],"maxTriggerRunsPerHour":4,"pending":[{"callId":"c1","tool":"run_shell","detail":"npm test"}],
                  "queuedMessages":0,"machine":{"agentId":"agent-1","machineName":"MAW-MB-02","online":true,"controls":"on","reportedAtMs":1}}]}
        """#
        let r = try JSONDecoder().decode(BotsListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.bots.first?.botId, "b1")
        XCTAssertEqual(r.bots.first?.machine?.canControl, true)
        XCTAssertEqual(r.bots.first?.pending?.first?.detail, "npm test")
        XCTAssertEqual(BotsFormat.status(r.bots[0]), "Idle")
        XCTAssertFalse(r.bots[0].isPaused)
    }

    func testPurchasePolicyIsSafeByDefault() {
        XCTAssertEqual(PurchaseMode(rawValue: "") ?? .none, .none)
        XCTAssertEqual(PurchasePolicy.effective(mode: .linkOutUS, storefrontCountry: "USA"), .linkOutUS)
        XCTAssertEqual(PurchasePolicy.effective(mode: .linkOutUS, storefrontCountry: "GBR"), .none)
        XCTAssertEqual(PurchasePolicy.effective(mode: .linkOutUS, storefrontCountry: nil), .none)
        XCTAssertEqual(PurchasePolicy.effective(mode: .none, storefrontCountry: "USA"), .none)
    }
}
