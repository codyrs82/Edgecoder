import Foundation

enum LocalModelState: String {
    case notInstalled
    case downloading
    case ready
}

@MainActor
final class LocalModelManager: ObservableObject {
    static let shared = LocalModelManager()

    @Published var state: LocalModelState = .notInstalled
    @Published var selectedModel = "qwen2.5:0.5b"
    @Published var statusText = "No local model installed."
    @Published var lastInferenceOutput = ""

    func installLightweightModel() async {
        state = .downloading
        statusText = "Preparing Core ML/llama.cpp runtime..."
        // Placeholder implementation: wire to actual download + conversion pipeline.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        state = .ready
        statusText = "Local model runtime ready (llama.cpp/Core ML scaffold)."
    }

    func runInference(prompt: String) async {
        guard state == .ready else {
            statusText = "Install model before running inference."
            return
        }
        // Placeholder output until llama.cpp/Core ML bridge is linked.
        lastInferenceOutput = "[local:\(selectedModel)] \(prompt.prefix(120))"
    }
}
