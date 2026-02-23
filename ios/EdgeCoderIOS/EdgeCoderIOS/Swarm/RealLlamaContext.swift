import Foundation
import SwiftLlama

/// Real llama.cpp context using SwiftLlama (pgorzelany/swift-llama-cpp).
/// Loads GGUF model files via the llama.cpp xcframework with Metal GPU acceleration.
final class RealLlamaContext: LlamaContextProtocol {
    private var service: LlamaService?
    private var modelPath: String?
    private(set) var isLoaded = false

    func loadModel(path: String) throws {
        unloadModel()

        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            throw LocalModelError.modelNotFound(path)
        }

        let config = LlamaConfig(
            batchSize: 512,
            maxTokenCount: 2048,
            useGPU: true
        )
        service = LlamaService(modelUrl: url, config: config)
        modelPath = path
        isLoaded = true
    }

    func unloadModel() {
        service = nil
        modelPath = nil
        isLoaded = false
    }

    func generate(prompt: String, maxTokens: Int) async throws -> String {
        guard isLoaded, let service else {
            throw LocalModelError.noModelLoaded
        }

        let messages = [LlamaChatMessage(role: .user, content: prompt)]
        let samplingConfig = LlamaSamplingConfig(
            temperature: 0.7,
            seed: UInt32.random(in: 0...UInt32.max)
        )

        let response = try await service.respond(
            to: messages,
            samplingConfig: samplingConfig
        )

        return response
    }

    deinit {
        service = nil
    }
}
