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
                       [.done(cSatsSpent: 3.4, compute: "Network · best fit", calls: nil, web: nil)])
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

    // MARK: Web search (docs/web-tool.md, src/portal/routes/chat.ts)

    func testChatBodyWebFlag() {
        let on = PortalChatClient.chatBody(conversationId: "c1", message: "What's new?", compute: .auto, web: true)
        XCTAssertEqual(on["web"] as? Bool, true)
        XCTAssertEqual(on["conversationId"] as? String, "c1")
        XCTAssertEqual(on["message"] as? String, "What's new?")
        XCTAssertEqual(on["compute"] as? [String: String], ["target": "auto"])
        XCTAssertNil(on["resend"])

        let off = PortalChatClient.chatBody(conversationId: "c1", message: "hi", compute: .network(model: "qwen3-coder:30b"), resend: true, web: false)
        XCTAssertNil(off["web"], "Off omits the flag, as the web page does")
        XCTAssertEqual(off["resend"] as? Bool, true)
        XCTAssertEqual(off["compute"] as? [String: String], ["target": "network", "model": "qwen3-coder:30b"])

        // It serialises to the JSON the portal's schema takes.
        let data = try! JSONSerialization.data(withJSONObject: on)
        let back = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(back["web"] as? Bool, true)
    }

    func testWebPreference() {
        XCTAssertTrue(WebSearchPreference.enabled(chatMode: nil, defaultOn: true))
        XCTAssertFalse(WebSearchPreference.enabled(chatMode: nil, defaultOn: false))
        XCTAssertFalse(WebSearchPreference.enabled(chatMode: "off", defaultOn: true))
        XCTAssertTrue(WebSearchPreference.enabled(chatMode: "auto", defaultOn: false))
        XCTAssertNil(WebSearchPreference.chatMode(on: true, defaultOn: true))
        XCTAssertEqual(WebSearchPreference.chatMode(on: false, defaultOn: true), "off")
        XCTAssertEqual(WebSearchPreference.chatMode(on: true, defaultOn: false), "auto")
        XCTAssertEqual(WebSearchPreference.storageKey, "edgecoder.web.auto")
    }

    func testWebProgressEvents() {
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"status":"Searching the web…"}"#), [.status("Searching the web…")])
        let line = #"data: {"web":{"searches":1,"pages":0,"cSats":0.5,"sources":[{"n":1,"title":"Box office","url":"https://www.example.com/film"}]}}"#
        XCTAssertEqual(PortalChatParser.events(fromLine: line),
                       [.web(PortalWebUsage(searches: 1, pages: 0, cSats: 0.5, sources: [PortalWebSource(n: 1, title: "Box office", url: "https://www.example.com/film")], footer: nil))])
        guard case let .web(w)? = PortalChatParser.events(fromLine: line).first else { return XCTFail("no web") }
        XCTAssertEqual(w.footerLine, "1 search · 0.5 cSats")
        XCTAssertEqual(w.sources.first?.host, "example.com")
    }

    func testWebOffEvent() {
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"webOff":{"reason":"needs_csats","message":"Web search needs cSats"}}"#),
                       [.webOff(reason: "needs_csats", message: "Web search needs cSats")])
        XCTAssertEqual(PortalChatParser.events(fromLine: #"data: {"webOff":{"reason":"rate_limited","message":""}}"#),
                       [.webOff(reason: "rate_limited", message: "")])
        XCTAssertEqual(WebSearchPreference.offNote(reason: "needs_csats", message: ""), "Web search needs cSats")
        XCTAssertEqual(WebSearchPreference.offNote(reason: "rate_limited", message: ""), "Web search's hourly limit is used up; it's back within the hour.")
        XCTAssertNil(WebSearchPreference.offNote(reason: "not_configured", message: "Web search isn't set up yet"))
        XCTAssertEqual(WebSearchPreference.offNote(reason: "free_used", message: ""), "Today's free web searches on your machine are used up")
    }

    /// On your own machine the web is free: the server sends `free: true` and the footer says so,
    /// also while the reply works (progress events carry no footer, so it's built here).
    func testFreeWebOnYourMachine() {
        let progress = #"data: {"web":{"searches":2,"pages":0,"cSats":0,"free":true,"sources":[]}}"#
        guard case let .web(w)? = PortalChatParser.events(fromLine: progress).first else { return XCTFail("no web") }
        XCTAssertEqual(w.free, true)
        XCTAssertEqual(w.footerLine, "2 searches · free (your machine)")
        let done = #"data: {"done":true,"compute":"My machines · qwen3:8b","cSatsSpent":0,"web":{"searches":1,"pages":1,"cSats":0,"free":true,"sources":[],"footer":"1 search · 1 page · free (your machine)"}}"#
        guard case let .done(_, _, _, web)? = PortalChatParser.events(fromLine: done).first, let web else { return XCTFail("no done web") }
        XCTAssertEqual(web.free, true)
        XCTAssertEqual(web.footerLine, "1 search · 1 page · free (your machine)")
        // Without the flag (older servers, network chats) nothing changes.
        guard case let .web(paid)? = PortalChatParser.events(fromLine: #"data: {"web":{"searches":1,"pages":0,"cSats":0.5,"sources":[]}}"#).first else { return XCTFail("no web") }
        XCTAssertNil(paid.free)
        XCTAssertEqual(paid.footerLine, "1 search · 0.5 cSats")
        XCTAssertEqual(PortalWebUsage.footer(searches: 1, pages: 0, cSats: 0, free: true), "1 search · free (your machine)")
        // A reply that went past the free allowance and paid shows its cSats.
        XCTAssertEqual(PortalWebUsage.footer(searches: 2, pages: 0, cSats: 0.5, free: true), "2 searches · 0.5 cSats")
    }

    func testDoneEventCarriesWebSourcesAndFooter() {
        let line = #"data: {"done":true,"compute":"Your machine","cSatsSpent":1.2,"web":{"searches":2,"pages":1,"cSats":1.2,"sources":[{"n":1,"title":"A","url":"https://a.example/x"},{"n":3,"title":"C","url":"http://c.example/"},{"n":4,"title":"Bad","url":"javascript:alert(1)"}],"footer":"2 searches · 1 page · 1.2 cSats"}}"#
        let events = PortalChatParser.events(fromLine: line)
        XCTAssertEqual(events.count, 1, "the done's web is not also a progress event")
        guard case let .done(cSats, compute, _, web)? = events.first, let web else { return XCTFail("no done web") }
        XCTAssertEqual(cSats, 1.2)
        XCTAssertEqual(compute, "Your machine")
        XCTAssertEqual(web.footerLine, "2 searches · 1 page · 1.2 cSats")
        XCTAssertEqual(web.sources.map(\.n), [1, 3, 4])
        XCTAssertEqual(web.sources.compactMap(\.link).map(\.absoluteString), ["https://a.example/x", "http://c.example/"], "only http(s) sources are links")
        // A done without the web: no web.
        guard case let .done(_, _, _, none)? = PortalChatParser.events(fromLine: #"data: {"done":true,"cSatsSpent":0}"#).first else { return XCTFail("no done") }
        XCTAssertNil(none)
    }

    func testWebFooterMatchesPortal() {
        XCTAssertEqual(PortalWebUsage.footer(searches: 0, pages: 0, cSats: 0), "")
        XCTAssertEqual(PortalWebUsage.footer(searches: 1, pages: 0, cSats: 0.5), "1 search · 0.5 cSats")
        XCTAssertEqual(PortalWebUsage.footer(searches: 2, pages: 1, cSats: 1.2), "2 searches · 1 page · 1.2 cSats")
        XCTAssertEqual(PortalWebUsage.footer(searches: 3, pages: 4, cSats: 2.3000000000000003), "3 searches · 4 pages · 2.3 cSats")
        XCTAssertEqual(PortalWebUsage.footer(searches: 2, pages: 0, cSats: 1), "2 searches · 1 cSats")
        XCTAssertEqual(PortalWebUsage.footer(searches: 0, pages: 1, cSats: 0.2), "1 page · 0.2 cSats")
    }

    func testOlderSavedMessagesDecodeWithoutWebFields() throws {
        let msg = ChatMessage(role: .assistant, content: "hi", footer: "free")
        var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(msg)) as! [String: Any]
        json.removeValue(forKey: "webSources")
        let back = try JSONDecoder().decode(ChatMessage.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(back.webSources)
        XCTAssertEqual(back.content, "hi")
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

    func testDoneEventCarriesUsageCalls() {
        let line = #"data: {"done":true,"compute":"Network · best fit","cSatsSpent":3.4,"usage":{"cSats":3.4,"where":"Network · best fit","calls":[{"cSats":3.4,"model":"network/qwen3-coder:30b","served":{"label":"m1","own":false,"computeClass":"gpu","tier":null,"hardware":"Datacenter GPU (x)","gpu":"2× NVIDIA A16","region":"us-central","city":"Chicago","country":"US","promptTokens":24800,"promptMs":81000,"outputTokens":312,"genMs":6500}}]}}"#
        guard case let .done(cSats, compute, calls, _)? = PortalChatParser.events(fromLine: line).first else { return XCTFail("no done") }
        XCTAssertEqual(cSats, 3.4)
        XCTAssertEqual(compute, "Network · best fit")
        XCTAssertEqual(ServedFormatter.servedLine(calls), "qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats")
    }

    func testWithdrawSteps() throws {
        func w(_ json: String) throws -> WithdrawResponse { try JSONDecoder().decode(WithdrawResponse.self, from: Data(json.utf8)) }
        XCTAssertEqual(WithdrawStep.classify(status: 403, response: try w(#"{"error":"two_factor_required","detail":"Enter the code from your authenticator app (or a recovery code) to continue.","methods":["totp","passkey"]}"#)),
                       .twoFactorCode("Enter the code from your authenticator app (or a recovery code) to continue."))
        XCTAssertEqual(WithdrawStep.classify(status: 403, response: try w(#"{"error":"two_factor_required","detail":"Confirm with your passkey to continue.","methods":["passkey"]}"#)), .passkeyOnWeb)
        XCTAssertEqual(WithdrawStep.classify(status: 423, response: try w(#"{"ok":false,"code":"payout_destination_cooling_off","unlocksAtMs":1,"detail":"A new payout address was added."}"#)), .held("A new payout address was added."))
        XCTAssertEqual(WithdrawStep.classify(status: 202, response: try w(#"{"verificationRequired":true,"challengeId":"c1","amountMsat":1000}"#)), .other)
    }

    func testBotsListWithPendingAndNewBotBody() throws {
        let json = ##"{"machines":[],"bots":[],"pending":[{"requestId":"req-12345678","botId":"web-1","name":"Docs","role":"","color":"#6e56cf","state":"waiting","target":null,"machineName":null,"createdAtMs":1}],"targets":[{"agentId":"a1","machineName":"Mac","online":true,"canCreate":true}],"canCreate":true}"##
        let r = try JSONDecoder().decode(BotsListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.pending?.first.map(BotsFormat.pendingState), "Waiting for a machine to come online")
        XCTAssertEqual(r.targets?.first?.agentId, "a1")
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(NewBotRequest(requestId: "req-12345678", agentId: nil, bot: .init(name: "Docs", role: "", instructions: "")))) as? [String: Any]
        XCTAssertTrue(body?["agentId"] is NSNull)
        XCTAssertEqual((body?["bot"] as? [String: Any])?["name"] as? String, "Docs")
    }
}
