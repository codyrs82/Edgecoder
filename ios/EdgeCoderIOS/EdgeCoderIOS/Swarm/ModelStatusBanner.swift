import SwiftUI

struct ModelStatusBanner: View {
    @ObservedObject var modelManager: LocalModelManager

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(modelManager.selectedModel.isEmpty ? "No Model" : modelManager.selectedModel)
                    .font(.caption.bold())
                Text(modelManager.statusText)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            Spacer()
            if modelManager.state == .loading || modelManager.state == .downloading {
                ProgressView()
                    .scaleEffect(0.7)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.systemGray6))
        .cornerRadius(8)
    }

    private var statusColor: Color {
        switch modelManager.state {
        case .ready: return .green
        case .loading, .downloading: return .orange
        case .error: return .red
        case .notInstalled: return .gray
        }
    }
}
