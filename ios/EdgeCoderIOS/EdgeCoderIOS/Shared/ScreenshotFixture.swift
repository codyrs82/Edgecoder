import Foundation

/// Sample data for App Store screenshots: launch a Debug build with `-screenshotFixture` and every
/// tab draws generic sample data instead of asking the portal. No sign-in, no network calls, and no
/// buying UI (purchase mode is forced to `none`, as in Release). `-screenshotTab chat|bots|wallet|
/// machines|network` picks the tab it opens on (Chat by default). Implies `-networkFixture`.
/// Release builds never use it: everything here is compiled only in Debug.
enum ScreenshotFixture {
    static var isEnabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-screenshotFixture")
        #else
        return false
        #endif
    }

    #if DEBUG
    /// The tab named by `-screenshotTab <name>`, lowercased; nil when not given.
    static var openingTab: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-screenshotTab"), i + 1 < args.count else { return nil }
        return args[i + 1].lowercased()
    }

    /// A generic signed-in account (no real person or address).
    static let user = PortalUser(userId: "sample-account", email: "sample@example.com", emailVerified: true)

    static let network = "bitcoin"
    static let cSats: Double = 12_450

    private static var nowMs: Double { (Date().timeIntervalSince1970 * 1000).rounded() }
    private static func ago(minutes: Double) -> Double { nowMs - minutes * 60_000 }

    private static func decode<T: Decodable>(_ json: String) -> T? {
        try? JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: Chat

    static let question = "How do I debounce a search field in SwiftUI so it only queries after the user stops typing?"

    static let answer = """
    Run the search in a task keyed on the query. SwiftUI cancels the previous task whenever the text changes, so a short sleep at the start acts as the debounce:

    ```swift
    .searchable(text: $query)
    .task(id: query) {
      try? await Task.sleep(for: .seconds(0.3))
      guard !Task.isCancelled else { return }
      results = await api.search(query)
    }
    ```

    Typing quickly keeps cancelling the sleep, so only the last value runs a search. No Combine, timers or manual cleanup needed.
    """

    /// What the reply's done event carries for a call that ran on your own Mac (src/swarm/served-by.ts).
    static let calls: [CallUsage] = [
        CallUsage(cSats: 0, where: "mine", model: "qwen3-coder:30b",
                  served: ServedInfo(label: "your machine (Mac)", own: true, computeClass: "apple", tier: "apple.m.hi",
                                     hardware: "Apple silicon (apple.m.hi)", gpu: "Apple M2 Ultra", region: nil, city: nil, country: nil,
                                     pickupMs: 40, promptMs: 620, genMs: 5_400, promptTokens: 1_240, outputTokens: 286, usd: nil)),
    ]

    /// The footer ChatView puts under a finished reply (ServedFormatter, as for a real reply).
    static var answerFooter: String? { ServedFormatter.servedLine(calls) }

    static var conversation: Conversation {
        var c = Conversation(source: .chat)
        c.addMessage(role: .user, content: question)
        c.addMessage(role: .assistant, content: answer, footer: answerFooter)
        return c
    }

    // MARK: Wallet

    static var walletJSON: String {
        #"""
        {"connected":true,"network":"bitcoin","cSats":12450,"earnedSats":3180,
         "btcUsd":97000,"rateStale":false,
         "fees":{"purchaseFeeBps":0,"networkFeeBps":500},
         "topup":{"minSats":100,"maxSats":1000000},
         "launch":null,
         "classes":{
           "cpu":{"label":"CPU","cSatsPerSecondBaseTier":0.0057},
           "gpu":{"label":"GPU","cSatsPerSecondBaseTier":0.0278},
           "apple":{"label":"Apple silicon","cSatsPerSecondBaseTier":0.0333},
           "gpu.dc":{"label":"Datacenter GPU","cSatsPerSecondBaseTier":0.1944}
         },
         "models":[
           {"model":"qwen3-coder:30b","agents":6,"cSatsPerMTokens":{"input":30,"output":120}},
           {"model":"qwen3.5:9b","agents":9,"cSatsPerMTokens":{"input":10,"output":40}},
           {"model":"llama3.2:3b","agents":5,"cSatsPerMTokens":{"input":4,"output":16}}
         ],
         "recent":[
           {"type":"earn","cSats":41.8,"reason":"compute_contribution:job","atMs":\#(ago(minutes: 12))},
           {"type":"spend","cSats":3.42,"reason":"inference:qwen3-coder:30b","atMs":\#(ago(minutes: 47))},
           {"type":"earn","cSats":118.5,"reason":"compute_contribution:job","atMs":\#(ago(minutes: 190))},
           {"type":"spend","cSats":12.6,"reason":"inference:qwen3.5:9b","atMs":\#(ago(minutes: 320))},
           {"type":"earn","cSats":64.3,"reason":"compute_contribution:job","atMs":\#(ago(minutes: 1_300))},
           {"type":"spend","cSats":1500,"reason":"payout:ln","atMs":\#(ago(minutes: 2_900))}
         ],
         "payouts":{
           "balance":{"earnedMsat":3180000,"heldMsat":160000,"maturesAtMs":\#(ago(minutes: -600)),"paidMsat":1500000,"pendingMsat":0,"payableMsat":1520000},
           "policy":{"network":"bitcoin","minPayoutSats":100,"maxFeeBps":100,"autoMinPayoutSats":1000,"lightningEnabled":true,"paused":false,
                     "limits":{"maxSingleSats":100000,"maxAccountDailySats":500000}},
           "payouts":[
             {"createdAtMs":\#(ago(minutes: 2_900)),"kind":"manual","amountMsat":1500000,"feeMsat":2000,"status":"paid","error":null,"txid":null}
           ]
         }}
        """#
    }

    static var wallet: WalletOverview? { decode(walletJSON) }

    // MARK: Machines and bots

    static var botsJSON: String {
        #"""
        {"machines":[
           {"agentId":"sample-mac-studio","machineName":"Mac Studio","online":true,"controls":"on","reportedAtMs":\#(ago(minutes: 0.2))},
           {"agentId":"sample-gpu-server","machineName":"lambda-a100-gpu0","online":true,"controls":"on","reportedAtMs":\#(ago(minutes: 0.4))},
           {"agentId":"sample-macbook","machineName":"MacBook Pro","online":false,"controls":"view","reportedAtMs":\#(ago(minutes: 185))}
         ],
         "bots":[
           {"id":"bot-review","name":"Code Reviewer","role":"Reviews pull requests","color":"#7C5CFF","status":"waiting_approval","enabled":true,
            "folderName":"web-app","runsToday":3,"maxRunsPerDay":20,"budgetCSatsPerDay":200,"spentTodayCSats":0,
            "pending":[{"callId":"call-1","tool":"run_command","detail":"npm test -- src/search"}],
            "machine":{"agentId":"sample-mac-studio","machineName":"Mac Studio","online":true,"controls":"on"}},
           {"id":"bot-docs","name":"Docs Writer","role":"Keeps the README current","color":"#22A06B","status":"running","activity":"updating docs/api.md","enabled":true,
            "folderName":"web-app","runsToday":1,"maxRunsPerDay":10,
            "machine":{"agentId":"sample-mac-studio","machineName":"Mac Studio","online":true,"controls":"on"}},
           {"id":"bot-tests","name":"Nightly Tests","role":"Runs the full suite every night","color":"#E8A317","status":"idle","enabled":true,
            "folderName":"ml-pipeline","schedule":"Daily at 02:00","runsToday":1,"maxRunsPerDay":4,
            "machine":{"agentId":"sample-gpu-server","machineName":"lambda-a100-gpu0","online":true,"controls":"on"}},
           {"id":"bot-triage","name":"Issue Triage","role":"Labels new issues","color":"#3B82F6","status":"idle","enabled":true,
            "runtime":"cloud","agentId":"cloud","runsToday":5,"maxRunsPerDay":48}
         ],
         "pending":[],
         "targets":[
           {"agentId":"cloud","machineName":"Cloud","online":true,"canCreate":true},
           {"agentId":"sample-mac-studio","machineName":"Mac Studio","online":true,"canCreate":true},
           {"agentId":"sample-gpu-server","machineName":"lambda-a100-gpu0","online":true,"canCreate":true},
           {"agentId":"sample-macbook","machineName":"MacBook Pro","online":false,"canCreate":true}
         ],
         "canCreate":true,
         "cloud":{"github":true}}
        """#
    }

    static var bots: BotsListResponse? { decode(botsJSON) }

    static var machinesJSON: String {
        #"""
        {"machines":[
           {"agentId":"sample-mac-studio","connected":true,"stateAtMs":\#(ago(minutes: 0.2)),"lastSeenMs":\#(ago(minutes: 0.1)),
            "state":{"activeModel":"qwen3-coder:30b","reportedAtMs":\#(ago(minutes: 0.2)),"remoteControl":"on"}},
           {"agentId":"sample-gpu-server","connected":true,"stateAtMs":\#(ago(minutes: 0.4)),"lastSeenMs":\#(ago(minutes: 0.1)),
            "state":{"activeModel":"qwen3.5:32b","reportedAtMs":\#(ago(minutes: 0.4)),"remoteControl":"on"}},
           {"agentId":"sample-macbook","connected":false,"stateAtMs":\#(ago(minutes: 185)),"lastSeenMs":\#(ago(minutes: 185)),
            "state":{"activeModel":"llama3.2:3b","reportedAtMs":\#(ago(minutes: 185)),"remoteControl":"view"}}
         ]}
        """#
    }

    static var machines: MachinesListResponse? { decode(machinesJSON) }
    #endif
}
