import XCTest

/// The Network tab: GET /portal/api/network/world decoded, laid out and masked.
final class NetworkWorldTests: XCTestCase {
    private func decode(_ json: String) throws -> NetworkWorld {
        try JSONDecoder().decode(NetworkWorld.self, from: Data(json.utf8))
    }

    /// Modeled on the portal's allowlist (cleanWorld in src/portal/routes/network-world.ts).
    private let sample = #"""
    {"connected":true,"generatedAtMs":1763380000000,"servedBy":"c1",
     "coordinators":[
       {"id":"c1","url":"https://coordinator.edgecoder.io","region":"iad","country":"US","continent":"NA","agents":3,"agentsOnline":2,"reachable":true,"self":true,"myRttMs":null,"pingUrl":"https://coordinator.edgecoder.io/identity"},
       {"id":"c2","url":"https://coordinator-eu.edgecoder.io","region":"fra","country":"DE","continent":"EU","agents":1,"agentsOnline":1,"reachable":false,"self":false,"myRttMs":null,"pingUrl":null}
     ],
     "links":[{"from":"c1","to":"c2","rttMs":84.5,"workPerMin":12,"gossipPerMin":50},{"from":"c1","to":"nowhere","rttMs":1,"workPerMin":0,"gossipPerMin":0}],
     "agents":[
       {"id":"aaaa000001","label":"mac-•••0001","mine":true,"name":"desktop-studio-local-5173","os":"macos","region":"iad","country":"US","continent":"NA","computeClass":"gpu-apple","tier":null,"vramGb":32,"models":["qwen3.5:9b"],"modelsTotal":1,"activeModel":"qwen3.5:9b","status":"busy","slots":2,"slotsUsed":1,"coordinatorId":"c1","rttMs":12,"activity":{"callsNow":1,"streaming":1,"callsPerMin":7}},
       {"id":"bbbb000002","label":"lin-•••0002","mine":false,"name":"leaked-host","os":"linux","region":"iad","country":"US","continent":"NA","computeClass":"cpu","tier":null,"vramGb":null,"models":[],"modelsTotal":0,"activeModel":null,"status":"idle","slots":1,"slotsUsed":0,"coordinatorId":"c1","rttMs":null,"activity":{"callsNow":0,"streaming":0,"callsPerMin":3}},
       {"id":"cccc000003","label":"win-•••0003","mine":false,"os":"windows","region":"fra","country":"DE","continent":"EU","computeClass":"gpu","tier":"rtx","vramGb":12,"models":["llama3.2:3b"],"modelsTotal":1,"activeModel":null,"status":"stale","slots":1,"slotsUsed":0,"coordinatorId":"c2","rttMs":40},
       {"id":"dddd000004","label":"lin-•••0004","mine":false,"os":"linux","status":"weird","coordinatorId":"c1"}
     ],
     "models":[{"model":"qwen3.5:9b","agents":1,"online":1}],
     "totals":{"coordinators":2,"agents":4,"online":3,"busy":1,"mine":1,"models":2,"slots":5,"slotsUsed":1},
     "yourRequests":[{"coordinator":"c1","machineKey":"aaaa000001","state":"streaming"},{"coordinator":"c1","machineKey":null,"state":"queued"}],
     "truncated":false}
    """#

    func testDecodesSampleWorld() throws {
        let w = try decode(sample)
        XCTAssertTrue(w.connected)
        XCTAssertEqual(w.coordinators.map(\.id), ["c1", "c2"])
        XCTAssertEqual(w.coordinators[0].pingUrl, "https://coordinator.edgecoder.io/identity")
        XCTAssertFalse(w.coordinators[1].reachable)
        XCTAssertNil(w.coordinators[1].pingUrl)
        XCTAssertEqual(w.links.count, 2)
        XCTAssertEqual(w.links[0].workPerMin, 12)
        XCTAssertEqual(w.links[0].rttMs, 84.5)
        XCTAssertEqual(w.agents.count, 4)
        let mine = w.agents[0]
        XCTAssertTrue(mine.mine)
        XCTAssertEqual(mine.name, "desktop-studio-local-5173")
        XCTAssertEqual(mine.status, .busy)
        XCTAssertEqual(mine.activity, WorldActivity(callsNow: 1, streaming: 1, callsPerMin: 7))
        // Missing activity, unknown status: tolerated.
        XCTAssertNil(w.agents[2].activity)
        XCTAssertEqual(w.agents[3].status, .stale)
        XCTAssertEqual(w.totals?.online, 3)
        XCTAssertEqual(w.yourRequests.count, 2)
        XCTAssertEqual(w.yourRequests[0].state, .streaming)
        XCTAssertNil(w.yourRequests[1].machineKey)
        XCTAssertEqual(NetworkText.summary(w), "2 coordinators · 3 machines online · 10 calls/min")
    }

    func testOneBadElementDoesNotFailTheAnswer() throws {
        let w = try decode(#"{"coordinators":[{"id":"c1","url":"https://x.io"},{"url":"no id"}],"agents":[{"id":"a"}],"links":[]}"#)
        XCTAssertEqual(w.coordinators.count, 1)
        XCTAssertTrue(w.agents.isEmpty) // no coordinatorId
        XCTAssertTrue(w.yourRequests.isEmpty)
    }

    func testFixtureDecodes() {
        let w = NetworkFixture.world
        XCTAssertEqual(w.coordinators.count, 3)
        XCTAssertEqual(w.agents.count, 14)
        XCTAssertEqual(w.agents.filter(\.mine).count, 3)
    }

    // MARK: Masking

    func testNonMineMachinesNeverKeepANameOrGetALabel() throws {
        let w = try decode(sample)
        XCTAssertNil(w.agents[1].name, "a machine not marked mine drops any name it was sent")
        for a in w.agents where !a.mine { XCTAssertNil(a.name) }
        for world in [w, NetworkFixture.world] {
            let layout = NetworkGraph.layout(world)
            let mineIds = Set(world.agents.filter(\.mine).map(\.id))
            XCTAssertFalse(layout.labels.isEmpty)
            for label in layout.labels {
                XCTAssertTrue(mineIds.contains(label.id), "only your machines are named")
                let agent = world.agents.first { $0.id == label.id }!
                XCTAssertNotEqual(label.text, agent.label)
            }
            let nonMineLabels = world.agents.filter { !$0.mine }.map(\.label)
            for label in layout.labels { XCTAssertFalse(nonMineLabels.contains(label.text)) }
        }
        // The initializer guards too.
        let m = WorldMachine(id: "x", label: "lin-•••0000", mine: false, name: "secret", os: "linux", status: .idle, coordinatorId: "c1")
        XCTAssertNil(m.name)
    }

    func testShortName() {
        XCTAssertEqual(NetworkText.shortMachineName("desktop-studio-local-5173"), "studio")
        XCTAssertEqual(NetworkText.shortMachineName("lambda-a100"), "lambda-a100")
        XCTAssertEqual(NetworkText.shortMachineName("a-very-long-machine-name-that-goes-on"), "a-very-long-machine-n…")
    }

    // MARK: Layout

    func testLayoutIsDeterministic() throws {
        let w = try decode(sample)
        XCTAssertEqual(NetworkGraph.layout(w), NetworkGraph.layout(w))
        // Order of the answer does not matter.
        let shuffled = NetworkWorld(coordinators: w.coordinators.reversed(), links: w.links, agents: w.agents.reversed(),
                                    totals: w.totals, yourRequests: w.yourRequests)
        let a = NetworkGraph.layout(w), b = NetworkGraph.layout(shuffled)
        XCTAssertEqual(a.hubs.map(\.id), b.hubs.map(\.id))
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: a.machines.map { ($0.id, [$0.x, $0.y]) }),
                       Dictionary(uniqueKeysWithValues: b.machines.map { ($0.id, [$0.x, $0.y]) }))
        XCTAssertEqual(NetworkGraph.layout(NetworkFixture.world, columns: 2), NetworkGraph.layout(NetworkFixture.world, columns: 2))
    }

    func testNodesWithinBoundsAndHubsApart() {
        for columns in 1...3 {
            for world in [NetworkFixture.world, manyCoordinators(7)] {
                let l = NetworkGraph.layout(world, columns: columns)
                XCTAssertEqual(l.hubs.count, world.coordinators.count)
                for h in l.hubs {
                    XCTAssertGreaterThanOrEqual(h.x - NetworkGraph.hubR, 0)
                    XCTAssertLessThanOrEqual(h.x + NetworkGraph.hubR, l.width)
                    XCTAssertGreaterThanOrEqual(h.y - NetworkGraph.hubR, 0)
                    XCTAssertLessThanOrEqual(h.y + NetworkGraph.hubR, l.height)
                }
                for n in l.machines {
                    XCTAssertGreaterThanOrEqual(n.x - n.r, 0)
                    XCTAssertLessThanOrEqual(n.x + n.r, l.width)
                    XCTAssertGreaterThanOrEqual(n.y - n.r, 0)
                    XCTAssertLessThanOrEqual(n.y + n.r, l.height)
                }
                for i in l.hubs.indices {
                    for j in l.hubs.indices where j > i {
                        let d = hypot(l.hubs[i].x - l.hubs[j].x, l.hubs[i].y - l.hubs[j].y)
                        XCTAssertGreaterThan(d, 2 * NetworkGraph.hubR, "hubs must not overlap")
                    }
                }
            }
        }
    }

    func testMachinesClusterAroundTheirCoordinator() {
        let l = NetworkGraph.layout(NetworkFixture.world)
        let hubs = Dictionary(uniqueKeysWithValues: l.hubs.map { ($0.id, $0) })
        for n in l.machines {
            XCTAssertEqual(n.hubId, n.machine.coordinatorId)
            let h = hubs[n.hubId]!
            let d = hypot(n.x - h.x, n.y - h.y)
            XCTAssertGreaterThanOrEqual(d, NetworkGraph.ringMin - 0.1)
            XCTAssertLessThanOrEqual(d, NetworkGraph.ringMax + 0.1)
        }
        // West to east: iad (NA), fra (EU), sin (AS).
        XCTAssertEqual(l.hubs.map(\.id), ["coord-iad", "coord-fra", "coord-sin"])
    }

    // MARK: Pulses

    func testPulseLanes() {
        let w = NetworkFixture.world
        let l = NetworkGraph.layout(w)
        let lanes = NetworkGraph.pulseLanes(w, layout: l)
        let byId = Dictionary(uniqueKeysWithValues: lanes.map { ($0.id, $0) })
        // Your request streams on lin-•••7182: its spoke is yours, toward the coordinator.
        let yours = byId["spoke:4e5f607182"]!
        XCTAssertTrue(yours.yours)
        XCTAssertEqual(yours.count, 3) // two streaming, one more for a busy minute
        XCTAssertEqual(byId["mesh:coord-fra|coord-iad"]?.count, 4)
        XCTAssertEqual(byId["mesh:coord-fra|coord-sin"]?.faint, true)
        XCTAssertNil(byId["spoke:1b2c3d4e5f"], "an idle machine has no pulses")
        XCTAssertLessThanOrEqual(lanes.reduce(0) { $0 + $1.count }, NetworkGraph.maxDots)
        let capped = NetworkGraph.pulseLanes(w, layout: l, cap: 2)
        XCTAssertEqual(capped.reduce(0) { $0 + $1.count }, 2)
        XCTAssertEqual(capped.first { $0.id == "spoke:4e5f607182" }?.count, 2, "your own line keeps its dots first")
        let p = NetworkGraph.pulseProgress(yours, index: 1, clockMs: 0)
        XCTAssertEqual(p.t, 1.0 / 3, accuracy: 0.0001)
    }

    private func manyCoordinators(_ n: Int) -> NetworkWorld {
        let coords = (0..<n).map { WorldCoordinator(id: "c\($0)", url: "https://c\($0).io", continent: ["NA", "EU", "AS"][$0 % 3]) }
        var agents: [WorldMachine] = []
        for i in 0..<60 {
            let rtt: Double? = i % 4 == 0 ? nil : Double(i * 7)
            let id = String(format: "%010x", i)
            agents.append(WorldMachine(id: id, label: "lin-•••0000", mine: i % 9 == 0, name: "m\(i)", os: "linux",
                                       status: .idle, slots: i % 10, coordinatorId: "c\(i % n)", rttMs: rtt))
        }
        let links = (1..<n).map { WorldLink(from: "c0", to: "c\($0)", workPerMin: $0 * 5) }
        return NetworkWorld(coordinators: coords, links: links, agents: agents)
    }
}
