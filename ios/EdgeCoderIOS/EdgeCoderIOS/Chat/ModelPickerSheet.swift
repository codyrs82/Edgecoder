import SwiftUI

struct ModelPickerSheet: View {
    @Binding var selectedModel: String?
    @Binding var isPresented: Bool

    let localModels: [InstalledModel]
    let localActiveModel: String
    let catalogModels: [CatalogModel]
    let blePeers: [BLEPeer]
    @State private var swarmModels: [SwarmModelInfo] = []
    @State private var isLoadingSwarm = false

    struct SwarmModelInfo: Identifiable, Decodable {
        let model: String
        let paramSize: Double
        let agentCount: Int
        let avgLoad: Double
        var id: String { model }
    }

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
                                Text("Best available route")
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

                // Swarm Network
                if !swarmModels.isEmpty {
                    Section("Swarm Network") {
                        ForEach(swarmModels) { model in
                            let cost = max(0.5, model.paramSize)
                            let available = model.agentCount > 0
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
                                            Text("\(String(format: "%.1f", cost)) credits")
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
            .onAppear { fetchSwarmModels() }
        }
    }

    private func fetchSwarmModels() {
        guard !isLoadingSwarm else { return }
        isLoadingSwarm = true
        let coordinatorURL = SwarmRuntimeController.shared.selectedCoordinatorURL
        guard let url = URL(string: "\(coordinatorURL)/models/available") else {
            isLoadingSwarm = false
            return
        }

        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let decoded = try JSONDecoder().decode([SwarmModelInfo].self, from: data)
                await MainActor.run {
                    swarmModels = decoded
                }
            } catch {
                // Silent -- swarm section just won't show
            }
            await MainActor.run {
                isLoadingSwarm = false
            }
        }
    }
}
