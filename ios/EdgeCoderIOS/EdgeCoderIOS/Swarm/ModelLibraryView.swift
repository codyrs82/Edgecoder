import SwiftUI

struct ModelLibraryView: View {
    @ObservedObject var modelManager: LocalModelManager
    @Environment(\.dismiss) private var dismiss
    @State private var downloadingModelId: String?
    @State private var downloadError: String?

    var body: some View {
        NavigationView {
            List {
                if !modelManager.installedModels.isEmpty {
                    Section("Installed") {
                        ForEach(modelManager.installedModels) { model in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(model.modelId)
                                        .font(.body)
                                    Text("\(model.paramSize, specifier: "%.1f")B params")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                if model.modelId == modelManager.selectedModel {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.green)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                Task {
                                    try? await modelManager.activate(modelId: model.modelId)
                                }
                            }
                        }
                        .onDelete { indexSet in
                            for index in indexSet {
                                modelManager.deleteModel(modelId: modelManager.installedModels[index].modelId)
                            }
                        }
                    }
                }

                if !modelManager.availableModels.isEmpty {
                    Section("Available for Download") {
                        ForEach(modelManager.availableModels) { entry in
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.displayName)
                                        .font(.body)
                                    HStack(spacing: 8) {
                                        Text("\(entry.paramSize, specifier: "%.1f")B")
                                        Text(entry.quantization)
                                        Text(entry.fileSizeDescription)
                                    }
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    if entry.minMemoryMB > 0 {
                                        Text("Requires \(entry.minMemoryMB)MB RAM")
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                    }
                                }
                                Spacer()
                                if downloadingModelId == entry.modelId {
                                    Button("Cancel") {
                                        modelManager.cancelDownload()
                                        downloadingModelId = nil
                                    }
                                    .font(.caption)
                                    .foregroundColor(.red)
                                } else {
                                    Button {
                                        downloadModel(entry)
                                    } label: {
                                        Image(systemName: "arrow.down.circle")
                                            .font(.title3)
                                    }
                                    .disabled(modelManager.state == .downloading)
                                }
                            }
                        }
                    }
                }

                Section("Status") {
                    HStack {
                        Text("State")
                        Spacer()
                        Text(modelManager.state.rawValue)
                            .foregroundColor(.secondary)
                    }
                    if modelManager.state == .downloading {
                        ProgressView(value: modelManager.downloadProgress)
                    }
                    Text(modelManager.statusText)
                        .font(.caption)
                        .foregroundColor(.secondary)
                    if let error = downloadError {
                        Text(error)
                            .font(.caption)
                            .foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("Model Library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func downloadModel(_ entry: CatalogModel) {
        downloadError = nil
        downloadingModelId = entry.modelId
        Task {
            do {
                try await modelManager.downloadFromCatalog(entry)
                downloadingModelId = nil
            } catch {
                downloadError = error.localizedDescription
                downloadingModelId = nil
            }
        }
    }
}
