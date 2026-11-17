import XCTest

/// The Machines tab: GET /portal/api/machines joined with GET /portal/api/bots.
final class MachinesTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private let machinesJSON = #"""
    {"accountId":"acct-u1","actions":["pull"],"catalog":[],
     "machines":[
       {"agentId":"agent-gpu","enrolled":true,"connected":true,"stateAtMs":1700000000000,"lastSeenMs":1700000005000,
        "state":{"activeModel":"qwen3.5:9b","reportedAtMs":1700000000000,"remoteControl":"on","ollamaReachable":true,
                 "installed":[{"name":"qwen3.5:9b","sizeBytes":5}],"gpu":{"model":"A100","count":1}},"audit":[]},
       {"agentId":"agent-laptop","enrolled":true,"connected":false,"state":null,"stateAtMs":null,"lastSeenMs":1699999000000,"audit":[]},
       {"agentId":"agent-new","enrolled":true,"connected":false,"state":null,"stateAtMs":null,"lastSeenMs":null,"audit":[]}
     ]}
    """#

    private let botsJSON = #"""
    {"machines":[{"agentId":"agent-laptop","machineName":"Studio laptop","online":false,"controls":"view","reportedAtMs":1699999500000}],
     "bots":[
       {"id":"b1","name":"Docs","status":"idle","enabled":true,"machine":{"agentId":"agent-laptop","machineName":"Studio laptop","online":false,"controls":"view"}},
       {"id":"b2","name":"Tests","status":"idle","enabled":true,"machine":{"agentId":"agent-laptop","machineName":"Studio laptop","online":false,"controls":"view"}}
     ],
     "targets":[{"agentId":"agent-gpu","machineName":"lambda-a100","online":true,"canCreate":false},
                {"agentId":"agent-laptop","machineName":"Studio laptop","online":false,"canCreate":true}]}
    """#

    func testParsesMachinesAndJoinsBots() throws {
        let m: MachinesListResponse = try decode(machinesJSON)
        XCTAssertEqual(m.machines.count, 3)
        XCTAssertEqual(m.machines[0].state?.activeModel, "qwen3.5:9b")
        XCTAssertNil(m.machines[1].state)

        let rows = MachinesDirectory.rows(machines: m, bots: try decode(botsJSON) as BotsListResponse)
        // Online first, then by name ("agent-new" before "Studio laptop").
        XCTAssertEqual(rows.map(\.agentId), ["agent-gpu", "agent-new", "agent-laptop"])
        let gpu = rows[0]
        XCTAssertEqual(gpu.name, "lambda-a100")
        XCTAssertTrue(gpu.online)
        XCTAssertEqual(gpu.model, "qwen3.5:9b")
        XCTAssertEqual(gpu.botCount, 0)
        XCTAssertEqual(gpu.lastSeenMs, 1700000005000)
        XCTAssertEqual(MachinesDirectory.status(gpu), "Online")

        let laptop = rows.first { $0.agentId == "agent-laptop" }!
        XCTAssertEqual(laptop.name, "Studio laptop")
        XCTAssertEqual(laptop.botCount, 2)
        XCTAssertNil(laptop.model)
        // The newer of the machines list and the bots relay.
        XCTAssertEqual(laptop.lastSeenMs, 1699999500000)

        // No name anywhere: the agent id.
        XCTAssertEqual(rows.first { $0.agentId == "agent-new" }?.name, "agent-new")
    }

    func testWithoutBotsList() throws {
        let rows = MachinesDirectory.rows(machines: try decode(machinesJSON), bots: nil)
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(rows.allSatisfy { $0.botCount == nil })
        XCTAssertEqual(rows[0].agentId, "agent-gpu")
    }

    func testEmptyState() throws {
        let m: MachinesListResponse = try decode(#"{"accountId":"acct-u1","machines":[],"actions":[],"catalog":[]}"#)
        XCTAssertTrue(MachinesDirectory.rows(machines: m, bots: nil).isEmpty)
        XCTAssertEqual(MachinesDirectory.emptyMessage,
                       "No machines yet. Add one from the EdgeCoder desktop app or a Linux/GPU server — see edgecoder.io/docs")
        XCTAssertFalse(MachinesDirectory.emptyMessage.contains("Mac"))
    }

    func testOfflineStates() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        func row(_ seen: Double?) -> MachineRow {
            MachineRow(agentId: "a", name: "box", online: false, lastSeenMs: seen, model: nil, botCount: nil)
        }
        XCTAssertEqual(MachinesDirectory.status(row(nil), now: now), "Offline · never seen")
        XCTAssertEqual(MachinesDirectory.status(row(1_700_000_000_000 - 30_000), now: now), "Offline · last seen just now")
        XCTAssertEqual(MachinesDirectory.status(row(1_700_000_000_000 - 5 * 60_000), now: now), "Offline · last seen 5 min ago")
        XCTAssertEqual(MachinesDirectory.status(row(1_700_000_000_000 - 3 * 3_600_000), now: now), "Offline · last seen 3 h ago")
        XCTAssertEqual(MachinesDirectory.status(row(1_700_000_000_000 - 86_400_000), now: now), "Offline · last seen 1 day ago")
        XCTAssertEqual(MachinesDirectory.status(row(1_700_000_000_000 - 3 * 86_400_000), now: now), "Offline · last seen 3 days ago")
        XCTAssertEqual(MachinesDirectory.botsLabel(1), "1 bot")
        XCTAssertEqual(MachinesDirectory.botsLabel(4), "4 bots")
    }
}
