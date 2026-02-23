import SwiftUI

struct ModelLibraryView: View {
    @ObservedObject var modelManager: LocalModelManager
    @Environment(\.dismiss) private var dismiss

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
}
