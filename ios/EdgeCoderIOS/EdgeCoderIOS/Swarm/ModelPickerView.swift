import SwiftUI

struct ModelPickerView: View {
    @ObservedObject var modelManager: LocalModelManager
    @State private var showLibrary = false

    var body: some View {
        Button {
            showLibrary = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Active Model")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(modelManager.selectedModel.isEmpty ? "No model selected" : modelManager.selectedModel)
                        .font(.body)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
        }
        .sheet(isPresented: $showLibrary) {
            ModelLibraryView(modelManager: modelManager)
        }
    }
}
