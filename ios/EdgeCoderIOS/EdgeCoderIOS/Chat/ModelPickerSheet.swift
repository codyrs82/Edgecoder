import SwiftUI

struct ModelPickerSheet: View {
    @Binding var selectedModel: String?
    @Binding var isPresented: Bool

    let localModels: [InstalledModel]
    let localActiveModel: String
    let catalogModels: [CatalogModel]
    let blePeers: [BLEPeer]
    /// Signed in: the portal lists your machines and the network's models.
    let isSignedIn: Bool
    @State private var remote = ModelPickerRemote()
    @State private var isLoading = false
    @State private var loaded = false
    @State private var machinesFailed = false
    @State private var modelsFailed = false

    var body: some View {
        NavigationView {
            List {
                // Auto option
                Section {
                    Button {
                        selectedModel = nil
                        isPresented = false
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Auto")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundColor(Theme.textPrimary)
                                Text("Your machines first, then the network")
                                    .font(.caption)
                                    .foregroundColor(Theme.textMuted)
                            }
                            Spacer()
                            if selectedModel == nil {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundColor(Theme.accent)
                            }
                        }
                    }
                }

                // On This Device
                Section("On This Device") {
                    ForEach(catalogModels) { catalog in
                        let installed = localModels.first(where: { $0.modelId == catalog.modelId })
                        let isAvailable = installed != nil

                        Button {
                            if isAvailable {
                                selectedModel = catalog.modelId
                                isPresented = false
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(catalog.displayName)
                                        .font(.subheadline)
                                        .foregroundColor(isAvailable ? Theme.textPrimary : Theme.textMuted)
                                    HStack(spacing: 8) {
                                        Text("\(String(format: "%.1f", catalog.paramSize))B")
                                            .font(.caption)
                                            .foregroundColor(Theme.textMuted)
                                        Text("Free")
                                            .font(.caption)
                                            .foregroundColor(Theme.accent)
                                    }
                                }
                                Spacer()
                                if selectedModel == catalog.modelId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(Theme.accent)
                                } else if !isAvailable {
                                    Text("Not downloaded")
                                        .font(.caption2)
                                        .foregroundColor(Theme.textMuted)
                                }
                            }
                        }
                        .disabled(!isAvailable)
                    }
                }

                // Nearby Devices
                if !blePeers.isEmpty {
                    Section("Nearby Devices") {
                        ForEach(blePeers, id: \.agentId) { peer in
                            Button {
                                selectedModel = peer.model
                                isPresented = false
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(peer.model)
                                            .font(.subheadline)
                                            .foregroundColor(Theme.textPrimary)
                                        HStack(spacing: 8) {
                                            Text("\(String(format: "%.1f", peer.modelParamSize))B")
                                                .font(.caption)
                                                .foregroundColor(Theme.textMuted)
                                            Text("Free")
                                                .font(.caption)
                                                .foregroundColor(Theme.accent)
                                        }
                                    }
                                    Spacer()
                                    if selectedModel == peer.model {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Theme.accent)
                                    }
                                    Image(systemName: peer.rssi > -60 ? "wifi" : "wifi.exclamationmark")
                                        .font(.caption)
                                        .foregroundColor(Theme.textMuted)
                                }
                            }
                        }
                    }
                }

                if isSignedIn && isLoading && !loaded {
                    Section {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Loading your machines and network models\u{2026}")
                                .font(.caption)
                                .foregroundColor(Theme.textMuted)
                        }
                        .accessibilityIdentifier("modelPickerLoading")
                    }
                }

                // My machines (free): the portal runs "mine" on whichever online machine has the model.
                if !remote.own.isEmpty {
                    Section {
                        ForEach(remote.own) { row in
                            Button {
                                selectedModel = row.choice
                                isPresented = false
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.model)
                                            .font(.subheadline)
                                            .foregroundColor(Theme.textPrimary)
                                        HStack(spacing: 8) {
                                            Text(row.machineName)
                                                .font(.caption)
                                                .foregroundColor(Theme.textMuted)
                                                .lineLimit(1)
                                            Text("Free")
                                                .font(.caption)
                                                .foregroundColor(Theme.accent)
                                        }
                                    }
                                    Spacer()
                                    if selectedModel == row.choice {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Theme.accent)
                                    }
                                }
                            }
                        }
                    } header: {
                        Text("My machines")
                    }
                }

                // Swarm Network
                if !remote.network.isEmpty {
                    Section("EdgeCoder Network") {
                        ForEach(remote.network) { model in
                            let cost = model.cost
                            let available = model.available
                            Button {
                                if available {
                                    selectedModel = model.model
                                    isPresented = false
                                }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(model.model)
                                            .font(.subheadline)
                                            .foregroundColor(available ? Theme.textPrimary : Theme.textMuted)
                                        HStack(spacing: 8) {
                                            Text("\(String(format: "%.1f", model.paramSize))B")
                                                .font(.caption)
                                                .foregroundColor(Theme.textMuted)
                                            Text("\(String(format: "%.1f", cost)) cSats")
                                                .font(.caption)
                                                .foregroundColor(Theme.accent)
                                            Text("\(model.agentCount) agent\(model.agentCount == 1 ? "" : "s")")
                                                .font(.caption2)
                                                .foregroundColor(Theme.textMuted)
                                        }
                                    }
                                    Spacer()
                                    if !available {
                                        Text("No agents")
                                            .font(.caption2)
                                            .foregroundColor(Theme.textMuted)
                                    } else if selectedModel == model.model {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Theme.accent)
                                    }
                                }
                            }
                            .disabled(!available)
                        }
                    }
                }

                if let note = ModelPickerSections.footer(signedIn: isSignedIn, loaded: loaded, machinesFailed: machinesFailed,
                                                         modelsFailed: modelsFailed, remote: remote) {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(note)
                                .font(.caption)
                                .foregroundColor(machinesFailed || modelsFailed ? Theme.red : Theme.textMuted)
                            if isSignedIn && (machinesFailed || modelsFailed) {
                                Button("Retry") { Task { await loadRemote() } }
                                    .font(.caption.weight(.semibold))
                                    .foregroundColor(Theme.accent)
                                    .disabled(isLoading)
                            }
                        }
                        .accessibilityIdentifier("modelPickerFooter")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.bgDeep)
            .navigationTitle("Select Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                        .foregroundColor(Theme.textSecondary)
                }
            }
            .refreshable { await loadRemote() }
            .task { await loadRemote() }
        }
    }

    /// Your machines (GET /portal/api/machines, named from /portal/api/bots) and the network's
    /// models (GET /portal/api/models), signed in; a failure stays on screen with Retry.
    private func loadRemote() async {
        guard isSignedIn, !isLoading else { return }
        isLoading = true
        defer { isLoading = false; loaded = true }
        let api = APIClient.shared
        let portal = api.config.portalBaseURL
        async let machines: MachinesListResponse = api.request(baseURL: portal, path: "/portal/api/machines")
        async let models: PortalModelsResponse = api.request(baseURL: portal, path: "/portal/api/models")
        // Machine names only; the rows still show without them.
        async let bots: BotsListResponse? = try? api.request(baseURL: portal, path: "/portal/api/bots") as BotsListResponse
        let m: MachinesListResponse? = try? await machines
        let n: PortalModelsResponse? = try? await models
        let b = await bots
        machinesFailed = m == nil
        modelsFailed = n == nil
        // Keep what loaded before when a retry fails.
        var next = ModelPickerSections.build(models: n, machines: m, bots: b)
        if m == nil { next.own = remote.own }
        if n == nil { next.network = remote.network }
        remote = next
    }
}
