import Foundation

/// A sample network for previews and screenshots: launch a Debug build with `-networkFixture` and the
/// app opens on the Network tab drawing this instead of asking the portal. Release builds never use it.
enum NetworkFixture {
    static var isEnabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-networkFixture")
        #else
        return false
        #endif
    }

    static var world: NetworkWorld {
        (try? JSONDecoder().decode(NetworkWorld.self, from: Data(json.utf8))) ?? NetworkWorld(coordinators: [], agents: [])
    }

    /// Shaped like the portal's answer (cleanWorld in src/portal/routes/network-world.ts).
    static let json = #"""
    {"connected":true,"generatedAtMs":1763380000000,"servedBy":"coord-iad",
     "coordinators":[
       {"id":"coord-iad","url":"https://coordinator-iad.edgecoder.io","region":"iad","country":"US","continent":"NA","agents":7,"agentsOnline":6,"reachable":true,"self":true,"myRttMs":null,"pingUrl":"https://coordinator-iad.edgecoder.io/identity"},
       {"id":"coord-fra","url":"https://coordinator-fra.edgecoder.io","region":"fra","country":"DE","continent":"EU","agents":5,"agentsOnline":5,"reachable":true,"self":false,"myRttMs":null,"pingUrl":"https://coordinator-fra.edgecoder.io/identity"},
       {"id":"coord-sin","url":"https://coordinator-sin.edgecoder.io","region":"sin","country":"SG","continent":"AS","agents":4,"agentsOnline":3,"reachable":true,"self":false,"myRttMs":null,"pingUrl":"https://coordinator-sin.edgecoder.io/identity"}
     ],
     "links":[
       {"from":"coord-iad","to":"coord-fra","rttMs":82,"workPerMin":34,"gossipPerMin":120},
       {"from":"coord-fra","to":"coord-sin","rttMs":161,"workPerMin":0,"gossipPerMin":40},
       {"from":"coord-iad","to":"coord-sin","rttMs":214,"workPerMin":6,"gossipPerMin":30}
     ],
     "agents":[
       {"id":"a1b2c3d4e5","label":"mac-•••d4e5","mine":true,"name":"desktop-studio-workstation-local-5173","os":"macos","region":"iad","country":"US","continent":"NA","computeClass":"gpu-apple","tier":null,"vramGb":64,"models":["qwen3.5:9b","llama3.2:3b"],"modelsTotal":2,"activeModel":"qwen3.5:9b","status":"busy","slots":4,"slotsUsed":2,"coordinatorId":"coord-iad","rttMs":18,"activity":{"callsNow":2,"streaming":2,"callsPerMin":24}},
       {"id":"f0e1d2c3b4","label":"lin-•••c3b4","mine":true,"name":"lambda-a100","os":"linux","region":"iad","country":"US","continent":"NA","computeClass":"gpu","tier":"a100","vramGb":80,"models":["qwen3.5:32b"],"modelsTotal":1,"activeModel":"qwen3.5:32b","status":"idle","slots":8,"slotsUsed":0,"coordinatorId":"coord-iad","rttMs":9,"activity":{"callsNow":0,"streaming":0,"callsPerMin":3}},
       {"id":"0a1b2c3d4e","label":"win-•••3d4e","mine":false,"os":"windows","region":"ord","country":"US","continent":"NA","computeClass":"gpu","models":["llama3.2:3b"],"modelsTotal":1,"activeModel":null,"status":"busy","slots":2,"slotsUsed":1,"coordinatorId":"coord-iad","rttMs":31,"activity":{"callsNow":1,"streaming":1,"callsPerMin":12}},
       {"id":"1b2c3d4e5f","label":"lin-•••4e5f","mine":false,"os":"linux","region":"iad","country":"US","continent":"NA","computeClass":"cpu","models":[],"modelsTotal":0,"activeModel":null,"status":"idle","slots":1,"slotsUsed":0,"coordinatorId":"coord-iad","rttMs":55,"activity":{"callsNow":0,"streaming":0,"callsPerMin":0}},
       {"id":"2c3d4e5f60","label":"mac-•••5f60","mine":false,"os":"macos","region":"yyz","country":"CA","continent":"NA","computeClass":"gpu-apple","models":["qwen3.5:9b"],"modelsTotal":1,"activeModel":"qwen3.5:9b","status":"idle","slots":2,"slotsUsed":0,"coordinatorId":"coord-iad","rttMs":120,"activity":{"callsNow":0,"streaming":0,"callsPerMin":1}},
       {"id":"3d4e5f6071","label":"ios-•••6071","mine":false,"os":"ios","region":null,"country":"US","continent":"NA","computeClass":"cpu","models":[],"modelsTotal":0,"activeModel":null,"status":"stale","slots":1,"slotsUsed":0,"coordinatorId":"coord-iad","rttMs":null,"activity":{"callsNow":0,"streaming":0,"callsPerMin":0}},
       {"id":"4e5f607182","label":"lin-•••7182","mine":false,"os":"linux","region":"fra","country":"DE","continent":"EU","computeClass":"gpu","models":["qwen3.5:32b"],"modelsTotal":1,"activeModel":"qwen3.5:32b","status":"busy","slots":4,"slotsUsed":3,"coordinatorId":"coord-fra","rttMs":12,"activity":{"callsNow":3,"streaming":2,"callsPerMin":61}},
       {"id":"5f60718293","label":"lin-•••8293","mine":false,"os":"linux","region":"ams","country":"NL","continent":"EU","computeClass":"cpu","models":["llama3.2:3b"],"modelsTotal":1,"activeModel":null,"status":"idle","slots":1,"slotsUsed":0,"coordinatorId":"coord-fra","rttMs":22,"activity":{"callsNow":0,"streaming":0,"callsPerMin":2}},
       {"id":"60718293a4","label":"win-•••93a4","mine":false,"os":"windows","region":"lhr","country":"GB","continent":"EU","computeClass":"gpu","models":["qwen3.5:9b"],"modelsTotal":1,"activeModel":"qwen3.5:9b","status":"busy","slots":2,"slotsUsed":1,"coordinatorId":"coord-fra","rttMs":40,"activity":{"callsNow":1,"streaming":0,"callsPerMin":8}},
       {"id":"718293a4b5","label":"and-•••a4b5","mine":false,"os":"android","region":"waw","country":"PL","continent":"EU","computeClass":"cpu","models":[],"modelsTotal":0,"activeModel":null,"status":"idle","slots":1,"slotsUsed":0,"coordinatorId":"coord-fra","rttMs":70,"activity":{"callsNow":0,"streaming":0,"callsPerMin":0}},
       {"id":"8293a4b5c6","label":"mac-•••b5c6","mine":true,"name":"travel-laptop","os":"macos","region":"fra","country":"DE","continent":"EU","computeClass":"gpu-apple","models":["llama3.2:3b"],"modelsTotal":1,"activeModel":"llama3.2:3b","status":"stale","slots":1,"slotsUsed":0,"coordinatorId":"coord-fra","rttMs":null,"activity":{"callsNow":0,"streaming":0,"callsPerMin":0}},
       {"id":"93a4b5c6d7","label":"lin-•••c6d7","mine":false,"os":"linux","region":"sin","country":"SG","continent":"AS","computeClass":"gpu","models":["qwen3.5:32b"],"modelsTotal":1,"activeModel":"qwen3.5:32b","status":"busy","slots":4,"slotsUsed":2,"coordinatorId":"coord-sin","rttMs":15,"activity":{"callsNow":2,"streaming":1,"callsPerMin":30}},
       {"id":"a4b5c6d7e8","label":"lin-•••d7e8","mine":false,"os":"linux","region":"nrt","country":"JP","continent":"AS","computeClass":"cpu","models":[],"modelsTotal":0,"activeModel":null,"status":"idle","slots":1,"slotsUsed":0,"coordinatorId":"coord-sin","rttMs":75,"activity":{"callsNow":0,"streaming":0,"callsPerMin":0}},
       {"id":"b5c6d7e8f9","label":"mac-•••e8f9","mine":false,"os":"macos","region":"syd","country":"AU","continent":"OC","computeClass":"gpu-apple","models":["qwen3.5:9b"],"modelsTotal":1,"activeModel":"qwen3.5:9b","status":"idle","slots":2,"slotsUsed":0,"coordinatorId":"coord-sin","rttMs":96,"activity":{"callsNow":0,"streaming":0,"callsPerMin":4}}
     ],
     "models":[{"model":"qwen3.5:9b","agents":5,"online":5}],
     "totals":{"coordinators":3,"agents":14,"online":12,"busy":5,"mine":3,"models":4,"slots":34,"slotsUsed":9},
     "yourRequests":[
       {"coordinator":"coord-fra","machineKey":"4e5f607182","state":"streaming"},
       {"coordinator":"coord-iad","machineKey":null,"state":"queued"}
     ],
     "truncated":false}
    """#
}
