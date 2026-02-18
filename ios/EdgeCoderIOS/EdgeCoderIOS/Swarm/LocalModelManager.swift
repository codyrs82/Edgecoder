import Foundation
import llama

enum LocalModelState: String {
    case notInstalled
    case downloading
    case loading
    case ready
    case error
}

/// Manages the on-device llama.cpp model used by the swarm runtime.
@MainActor
final class LocalModelManager: ObservableObject {
    static let shared = LocalModelManager()

    @Published var state: LocalModelState = .notInstalled
    @Published var selectedModel = "qwen2.5-coder:0.5b"
    @Published var statusText = "No local model installed."
    @Published var lastInferenceOutput = ""

    private var llamaModel: OpaquePointer? = nil
    private var llamaCtx: OpaquePointer? = nil

    // MARK: - Model paths

    private var modelFilename: String {
        switch selectedModel {
        case "qwen2.5-coder:0.5b", "qwen2.5:0.5b":
            return "qwen2.5-coder-0.5b-instruct-q4_k_m.gguf"
        default:
            return "\(selectedModel.replacingOccurrences(of: ":", with: "-")).gguf"
        }
    }

    private var modelDownloadURL: URL {
        URL(string: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf")!
    }

    private var modelFileURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent(modelFilename)
    }

    // MARK: - Install / Download

    func installLightweightModel() async {
        guard state != .downloading && state != .loading && state != .ready else { return }

        if FileManager.default.fileExists(atPath: modelFileURL.path) {
            await loadModel()
            return
        }

        state = .downloading
        statusText = "Downloading \(modelFilename)…"

        do {
            try await downloadModel()
            await loadModel()
        } catch {
            state = .error
            statusText = "Download failed: \(error.localizedDescription)"
        }
    }

    private func downloadModel() async throws {
        let dest = modelFileURL
        let (tmpURL, _) = try await URLSession.shared.download(from: modelDownloadURL)
        try FileManager.default.moveItem(at: tmpURL, to: dest)
    }

    // MARK: - Load model into llama.cpp

    private func loadModel() async {
        state = .loading
        statusText = "Loading model into llama.cpp…"

        let modelPath = modelFileURL.path
        guard FileManager.default.fileExists(atPath: modelPath) else {
            state = .notInstalled
            statusText = "Model file not found."
            return
        }

        unloadModel()

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            Task.detached(priority: .userInitiated) {
                var mparams = llama_model_default_params()
                mparams.n_gpu_layers = 99  // offload all layers to Metal

                let model = llama_load_model_from_file(modelPath, mparams)

                await MainActor.run {
                    if let model {
                        self.llamaModel = model
                        var cparams = llama_context_default_params()
                        cparams.n_ctx = 2048
                        cparams.n_batch = 512
                        self.llamaCtx = llama_new_context_with_model(model, cparams)
                        if self.llamaCtx != nil {
                            self.state = .ready
                            self.statusText = "Model ready: \(self.selectedModel)"
                        } else {
                            llama_free_model(model)
                            self.llamaModel = nil
                            self.state = .error
                            self.statusText = "Failed to create llama context."
                        }
                    } else {
                        self.state = .error
                        self.statusText = "Failed to load model."
                    }
                    continuation.resume()
                }
            }
        }
    }

    private func unloadModel() {
        if let ctx = llamaCtx { llama_free(ctx); llamaCtx = nil }
        if let model = llamaModel { llama_free_model(model); llamaModel = nil }
    }

    // MARK: - Inference

    func runInference(prompt: String, maxTokens: Int = 256) async {
        guard state == .ready, let model = llamaModel, let ctx = llamaCtx else {
            statusText = "Install model before running inference."
            return
        }

        lastInferenceOutput = ""

        let result = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            Task.detached(priority: .userInitiated) {
                let output = self.generateSync(prompt: prompt, model: model, ctx: ctx, maxTokens: maxTokens)
                continuation.resume(returning: output)
            }
        }

        lastInferenceOutput = result
    }

    /// Blocking generation — must be called off the main actor.
    nonisolated func generateSync(
        prompt: String,
        model: OpaquePointer,
        ctx: OpaquePointer,
        maxTokens: Int
    ) -> String {
        // Tokenize
        let promptCStr = prompt.cString(using: .utf8) ?? []
        let maxTok = Int32(prompt.utf8.count) + 32
        var tokens = [llama_token](repeating: 0, count: Int(maxTok))
        let nTokens = llama_tokenize(model, promptCStr, Int32(promptCStr.count), &tokens, maxTok, true, false)
        guard nTokens > 0 else { return "[tokenize error]" }
        tokens = Array(tokens.prefix(Int(nTokens)))

        // Initial decode
        var batch = llama_batch_init(Int32(tokens.count), 0, 1)
        defer { llama_batch_free(batch) }
        for (i, tok) in tokens.enumerated() {
            batch.token[i] = tok
            batch.pos[i] = Int32(i)
            batch.n_seq_id[i] = 1
            batch.seq_id[i]![0] = 0
            batch.logits[i] = i == tokens.count - 1 ? 1 : 0
        }
        batch.n_tokens = Int32(tokens.count)
        guard llama_decode(ctx, batch) == 0 else { return "[decode error]" }

        var output = ""
        var nCur = Int32(tokens.count)
        let nMax = nCur + Int32(maxTokens)

        while nCur < nMax {
            // Greedy sampling
            var candidates: [llama_token_data] = (0..<llama_n_vocab(model)).map {
                llama_token_data(id: $0, logit: llama_get_logits_ith(ctx, Int32(batch.n_tokens - 1))![$0], p: 0)
            }
            var candidateArr = llama_token_data_array(data: &candidates, size: candidates.count, selected: -1, sorted: false)
            let nextToken = llama_sample_token_greedy(ctx, &candidateArr)
            if nextToken == llama_token_eos(model) { break }

            var newBatch = llama_batch_init(1, 0, 1)
            defer { llama_batch_free(newBatch) }
            newBatch.token[0] = nextToken
            newBatch.pos[0] = nCur
            newBatch.n_seq_id[0] = 1
            newBatch.seq_id[0]![0] = 0
            newBatch.logits[0] = 1
            newBatch.n_tokens = 1
            guard llama_decode(ctx, newBatch) == 0 else { break }

            var piece = [CChar](repeating: 0, count: 256)
            let pieceLen = llama_token_to_piece(model, nextToken, &piece, 256, 0, false)
            if pieceLen > 0 { output += String(cString: piece) }
            nCur += 1
        }

        return output.isEmpty ? "[empty response]" : output
    }

    deinit {
        unloadModel()
    }
}
