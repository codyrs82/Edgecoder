import XCTest

/// The chat's Select Model sheet: GET /portal/api/models and GET /portal/api/machines, the
/// "My machines" and "EdgeCoder Network" sections, and the compute each choice sends.
final class ModelPickerTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private let modelsJSON = #"""
    {"local":[{"name":"qwen2.5-coder:1.5b","parameterSize":"1.5B","quantization":"Q4_K_M","running":true}],
     "swarm":[{"model":"qwen3.5:9b","paramSize":9,"agentCount":3},
              {"model":"llama3.2:1b","paramSize":0.3,"agentCount":0},
              {"model":"gemma3:4b","paramSize":4.3,"agentCount":1,"avgLoad":0.2}]}
    """#

    private let machinesJSON = #"""
    {"accountId":"acct-u1","latestAgentVersion":null,"actions":[],"catalog":[],
     "machines":[
       {"agentId":"agent-gpu","enrolled":true,"connected":true,"stateAtMs":1700000000000,"lastSeenMs":1700000005000,
        "state":{"activeModel":"qwen3.5:9b","reportedAtMs":1700000000000,"remoteControl":"on",
                 "installed":[{"name":"qwen3.5:9b","sizeBytes":5}]},
        "networkModels":["qwen3.5:9b"],"ownerModels":["qwen2.5-coder:32b"],"version":"1.2.0","updateAvailable":false,"audit":[]},
       {"agentId":"agent-mac","enrolled":true,"connected":true,"stateAtMs":1700000000000,"lastSeenMs":1700000005000,
        "state":{"activeModel":"llama3.2:3b","reportedAtMs":1700000000000,"remoteControl":"off",
                 "installed":[{"name":"llama3.2:3b","sizeBytes":5},{"name":"qwen3.5:9b","sizeBytes":6}]},"audit":[]},
       {"agentId":"agent-old","enrolled":true,"connected":true,"state":{"activeModel":"phi3:mini","reportedAtMs":1},"stateAtMs":1,"lastSeenMs":1,"audit":[]},
       {"agentId":"agent-off","enrolled":true,"connected":false,"state":{"activeModel":"mistral:7b","reportedAtMs":1},
        "networkModels":["mistral:7b"],"stateAtMs":1,"lastSeenMs":1,"audit":[]}
     ]}
    """#

    private let botsJSON = #"""
    {"machines":[],"bots":[],
     "targets":[{"agentId":"agent-gpu","machineName":"lambda-a100","online":true,"canCreate":false},
                {"agentId":"agent-mac","machineName":"Studio Mac","online":true,"canCreate":true}]}
    """#

    func testDecodesPortalModels() throws {
        let r: PortalModelsResponse = try decode(modelsJSON)
        XCTAssertEqual(r.local?.first?.name, "qwen2.5-coder:1.5b")
        XCTAssertEqual(r.local?.first?.running, true)
        XCTAssertEqual(r.swarm?.count, 3)
        XCTAssertEqual(r.swarm?[0], PortalSwarmModel(model: "qwen3.5:9b", paramSize: 9, agentCount: 3))
        XCTAssertEqual(r.swarm?[1].cost, 0.5)
        XCTAssertEqual(r.swarm?[1].available, false)
        let empty: PortalModelsResponse = try decode(#"{"local":[],"swarm":[]}"#)
        XCTAssertEqual(ModelPickerSections.network(empty), [])
    }

    func testNetworkSectionPutsModelsWithAgentsFirst() throws {
        let r: PortalModelsResponse = try decode(modelsJSON)
        XCTAssertEqual(ModelPickerSections.network(r).map(\.model), ["gemma3:4b", "qwen3.5:9b", "llama3.2:1b"])
    }

    func testDecodesMachinesWithModelLists() throws {
        let m: MachinesListResponse = try decode(machinesJSON)
        XCTAssertEqual(m.machines[0].networkModels, ["qwen3.5:9b"])
        XCTAssertEqual(m.machines[0].ownerModels, ["qwen2.5-coder:32b"])
        XCTAssertNil(m.machines[1].networkModels)
        XCTAssertEqual(m.machines[1].state?.installed?.map(\.name), ["llama3.2:3b", "qwen3.5:9b"])
    }

    func testMyMachinesRowsOnlineOnePerMachineModel() throws {
        let m: MachinesListResponse = try decode(machinesJSON)
        let rows = ModelPickerSections.ownModels(machines: m, bots: try decode(botsJSON) as BotsListResponse)
        XCTAssertEqual(rows.map { "\($0.model)@\($0.machineName)" }, [
            "llama3.2:3b@Studio Mac",       // installed (no coordinator lists)
            "phi3:mini@agent-old",          // active model only; named by its id
            "qwen2.5-coder:32b@lambda-a100", // owner-only model
            "qwen3.5:9b@lambda-a100",
            "qwen3.5:9b@Studio Mac",
        ])
        // The offline machine is left out.
        XCTAssertFalse(rows.contains { $0.agentId == "agent-off" })
        XCTAssertEqual(rows[0].choice, "mine/llama3.2:3b")
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    func testBuildSectionsAndFooter() throws {
        let models: PortalModelsResponse = try decode(modelsJSON)
        let machines: MachinesListResponse = try decode(machinesJSON)
        let remote = ModelPickerSections.build(models: models, machines: machines)
        XCTAssertEqual(remote.own.count, 5)
        XCTAssertEqual(remote.network.count, 3)
        XCTAssertNil(ModelPickerSections.footer(signedIn: true, loaded: true, machinesFailed: false, modelsFailed: false, remote: remote))

        let none = ModelPickerSections.build(models: nil, machines: nil)
        XCTAssertEqual(none, ModelPickerRemote())
        XCTAssertEqual(ModelPickerSections.footer(signedIn: true, loaded: true, machinesFailed: true, modelsFailed: true, remote: none),
                       "Couldn't load your machines and network models \u{2014} pull to retry")
        XCTAssertEqual(ModelPickerSections.footer(signedIn: true, loaded: true, machinesFailed: true, modelsFailed: false, remote: none),
                       "Couldn't load your machines \u{2014} pull to retry")
        XCTAssertEqual(ModelPickerSections.footer(signedIn: true, loaded: true, machinesFailed: false, modelsFailed: true, remote: none),
                       "Couldn't load network models \u{2014} pull to retry")
        XCTAssertEqual(ModelPickerSections.footer(signedIn: true, loaded: true, machinesFailed: false, modelsFailed: false, remote: none),
                       "No machines online and no network models right now.")
        XCTAssertNil(ModelPickerSections.footer(signedIn: true, loaded: false, machinesFailed: false, modelsFailed: false, remote: none))
        XCTAssertEqual(ModelPickerSections.footer(signedIn: false, loaded: false, machinesFailed: false, modelsFailed: false, remote: none),
                       "Sign in to use your machines and the EdgeCoder network.")
    }

    func testChoiceRoutesToPortalCompute() {
        XCTAssertEqual(ModelChoice.compute(for: nil), .auto)
        XCTAssertEqual(ModelChoice.compute(for: "mine/qwen3.5:9b"), .mine(model: "qwen3.5:9b"))
        XCTAssertEqual(ModelChoice.compute(for: "qwen3.5:9b"), .network(model: "qwen3.5:9b"))
        XCTAssertEqual(ModelChoice.compute(for: "mine/"), .network(model: "mine/"))
        XCTAssertEqual(ModelChoice.label(nil), "Auto")
        XCTAssertEqual(ModelChoice.label("mine/qwen3.5:9b"), "My machines \u{00B7} qwen3.5:9b")
        XCTAssertEqual(ModelChoice.label("gemma3:4b"), "gemma3:4b")
        // The chat body the portal's chatComputeSchema takes.
        let body = PortalChatClient.chatBody(conversationId: "c1", message: "hi", compute: ModelChoice.compute(for: "mine/qwen3.5:9b"), web: false)
        XCTAssertEqual(body["compute"] as? [String: String], ["target": "mine", "model": "qwen3.5:9b"])
    }
}
