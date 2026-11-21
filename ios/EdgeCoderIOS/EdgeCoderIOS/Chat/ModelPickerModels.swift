import Foundation

/// GET /portal/api/models (src/portal/routes/chat.ts): the portal's default-chat models (`local`)
/// and the network's models (`swarm`), signed in. The coordinator's own /models/available answers
/// 401 to the app, so the picker asks the portal.
struct PortalModelsResponse: Decodable, Equatable {
    let local: [PortalLocalModel]?
    let swarm: [PortalSwarmModel]?
}

struct PortalLocalModel: Decodable, Equatable {
    let name: String
    let parameterSize: String?
    let quantization: String?
    let running: Bool?
}

/// One network model: its size (billions of parameters) and how many agents serve it.
struct PortalSwarmModel: Decodable, Equatable, Identifiable {
    let model: String
    let paramSize: Double
    let agentCount: Int
    var id: String { model }

    /// cSats per message the picker shows (the network's floor of 0.5).
    var cost: Double { max(0.5, paramSize) }
    var available: Bool { agentCount > 0 }
}

/// One "My machines" row: a model one of your online machines can run, free.
struct OwnModelRow: Equatable, Identifiable {
    let model: String
    let machineName: String
    let agentId: String
    var id: String { "\(agentId)|\(model)" }
    /// The chat's stored choice for it (ModelChoice).
    var choice: String { ModelChoice.mine(model) }
}

/// What the picker shows beyond this device and nearby devices.
struct ModelPickerRemote: Equatable {
    var own: [OwnModelRow] = []
    var network: [PortalSwarmModel] = []
}

/// The chat's model choice is one string (Conversation.selectedModel), with the same ids the
/// desktop app and external tools use (desktop/src/lib/compute-choice.ts): nil is Auto,
/// "mine/<model>" is your own machines, anything else a model on this device, a nearby device or
/// the network. The portal (chatComputeSchema) runs "mine" on whichever of your online machines
/// has the model; it can't target one machine.
enum ModelChoice {
    static let minePrefix = "mine/"

    static func mine(_ model: String) -> String { minePrefix + model }

    /// The model of a "mine/<model>" choice, else nil.
    static func ownModel(_ choice: String?) -> String? {
        guard let c = choice, c.hasPrefix(minePrefix), c.count > minePrefix.count else { return nil }
        return String(c.dropFirst(minePrefix.count))
    }

    /// The portal chat's `compute` for a choice.
    static func compute(for choice: String?) -> PortalChatCompute {
        guard let choice else { return .auto }
        if let m = ownModel(choice) { return .mine(model: m) }
        return .network(model: choice)
    }

    /// The model chip: "Auto", "My machines · qwen3.5:9b", or the model.
    static func label(_ choice: String?) -> String {
        guard let choice else { return "Auto" }
        if let m = ownModel(choice) { return "My machines \u{00B7} \(m)" }
        return choice
    }
}

enum ModelPickerSections {
    /// "My machines": one row per model per online machine, by model then machine name. A machine's
    /// models are what the coordinator says a "mine" chat can run there (networkModels + ownerModels),
    /// else its installed Ollama models, else its active model. Names come from the bots list when
    /// it has them (MachinesDirectory).
    static func ownModels(machines: MachinesListResponse, bots: BotsListResponse? = nil) -> [OwnModelRow] {
        let rows = Dictionary(MachinesDirectory.rows(machines: machines, bots: bots).map { ($0.agentId, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [OwnModelRow] = []
        for m in machines.machines {
            guard let row = rows[m.agentId], row.online else { continue }
            var models = (m.networkModels ?? []) + (m.ownerModels ?? [])
            if models.isEmpty { models = (m.state?.installed ?? []).map(\.name) }
            if models.isEmpty, let a = m.state?.activeModel { models = [a] }
            var seen = Set<String>()
            for model in models where !model.isEmpty && seen.insert(model).inserted {
                out.append(OwnModelRow(model: model, machineName: row.name, agentId: m.agentId))
            }
        }
        return out.sorted { ($0.model.lowercased(), $0.machineName.lowercased()) < ($1.model.lowercased(), $1.machineName.lowercased()) }
    }

    /// The network section: models with agents first, then by name.
    static func network(_ models: PortalModelsResponse) -> [PortalSwarmModel] {
        (models.swarm ?? []).sorted { ($0.available ? 0 : 1, $0.model.lowercased()) < ($1.available ? 0 : 1, $1.model.lowercased()) }
    }

    static func build(models: PortalModelsResponse?, machines: MachinesListResponse?, bots: BotsListResponse? = nil) -> ModelPickerRemote {
        ModelPickerRemote(own: machines.map { ownModels(machines: $0, bots: bots) } ?? [],
                          network: models.map(network) ?? [])
    }

    /// The footer under the remote sections, or nil when there's nothing to say.
    static func footer(signedIn: Bool, loaded: Bool, machinesFailed: Bool, modelsFailed: Bool, remote: ModelPickerRemote) -> String? {
        if !signedIn { return "Sign in to use your machines and the EdgeCoder network." }
        switch (machinesFailed, modelsFailed) {
        case (true, true): return "Couldn't load your machines and network models \u{2014} pull to retry"
        case (true, false): return "Couldn't load your machines \u{2014} pull to retry"
        case (false, true): return "Couldn't load network models \u{2014} pull to retry"
        case (false, false):
            if loaded && remote.own.isEmpty && remote.network.isEmpty { return "No machines online and no network models right now." }
            return nil
        }
    }
}
