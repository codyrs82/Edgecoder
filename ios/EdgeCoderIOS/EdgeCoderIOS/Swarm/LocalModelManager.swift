import Foundation
import Combine
import CommonCrypto

// MARK: - Model Registry Entry

struct InstalledModel: Codable, Identifiable {
    let modelId: String
    let localPath: String
    let paramSize: Double
    let fileSizeBytes: Int64
    let checksumSha256: String

    var id: String { modelId }
}

// MARK: - Notifications

extension Notification.Name {
    static let modelDidChange = Notification.Name("edgecoder.modelDidChange")
    static let modelSwapStarted = Notification.Name("edgecoder.modelSwapStarted")
}

// MARK: - Llama Context Protocol

protocol LlamaContextProtocol {
    func loadModel(path: String) throws
    func unloadModel()
    func generate(prompt: String, maxTokens: Int) async throws -> String
    var isLoaded: Bool { get }
}

// MARK: - Stub Llama Context

final class StubLlamaContext: LlamaContextProtocol {
    private(set) var isLoaded = false
    private var modelPath: String?

    func loadModel(path: String) throws {
        modelPath = path
        isLoaded = true
    }

    func unloadModel() {
        modelPath = nil
        isLoaded = false
    }

    func generate(prompt: String, maxTokens: Int) async throws -> String {
        guard isLoaded else { throw LocalModelError.noModelLoaded }
        return "[stub-llama] \(prompt.prefix(80))"
    }
}

// MARK: - Errors

enum LocalModelError: Error, LocalizedError {
    case noModelLoaded
    case modelNotFound(String)
    case loadFailed(String)
    case checksumMismatch
    case insufficientMemory(required: Int, available: Int)

    var errorDescription: String? {
        switch self {
        case .noModelLoaded: return "No model is loaded."
        case .modelNotFound(let id): return "Model \(id) not found on device."
        case .loadFailed(let reason): return "Failed to load model: \(reason)"
        case .checksumMismatch: return "Model file checksum does not match catalog."
        case .insufficientMemory(let req, let avail):
            return "Insufficient memory: \(req)MB required, \(avail)MB available."
        }
    }
}

// MARK: - Local Model State

enum LocalModelState: String {
    case notInstalled, downloading, loading, ready, error
}

// MARK: - Local Model Manager

@MainActor
final class LocalModelManager: ObservableObject {
    @Published var state: LocalModelState = .notInstalled
    @Published var selectedModel: String = ""
    @Published var selectedModelParamSize: Double = 0
    @Published var statusText: String = "No local model installed."
    @Published var lastInferenceOutput: String = ""
    @Published var installedModels: [InstalledModel] = []
    @Published var downloadProgress: Double = 0

    private var llamaContext: LlamaContextProtocol
    private let registryKey = "edgecoder.installedModels"
    private let activeModelKey = "edgecoder.activeModel"

    init(llamaContext: LlamaContextProtocol = StubLlamaContext()) {
        self.llamaContext = llamaContext
        loadRegistry()
        let savedModel = UserDefaults.standard.string(forKey: activeModelKey) ?? ""
        if !savedModel.isEmpty, let model = installedModels.first(where: { $0.modelId == savedModel }) {
            selectedModel = model.modelId
            selectedModelParamSize = model.paramSize
        }
    }

    // MARK: - Model Directory

    static var modelsDirectory: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Models")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - Registry Persistence

    private func loadRegistry() {
        guard let data = UserDefaults.standard.data(forKey: registryKey),
              let models = try? JSONDecoder().decode([InstalledModel].self, from: data) else {
            installedModels = []
            return
        }
        installedModels = models
    }

    private func saveRegistry() {
        if let data = try? JSONEncoder().encode(installedModels) {
            UserDefaults.standard.set(data, forKey: registryKey)
        }
    }

    // MARK: - Model Activation

    func activate(modelId: String) async throws {
        guard let model = installedModels.first(where: { $0.modelId == modelId }) else {
            throw LocalModelError.modelNotFound(modelId)
        }

        let previousModel = selectedModel
        state = .loading
        statusText = "Loading \(model.modelId)..."
        NotificationCenter.default.post(name: .modelSwapStarted, object: nil)

        llamaContext.unloadModel()

        do {
            try llamaContext.loadModel(path: model.localPath)
        } catch {
            state = .error
            statusText = "Failed to load \(model.modelId): \(error.localizedDescription)"
            if !previousModel.isEmpty,
               let prev = installedModels.first(where: { $0.modelId == previousModel }) {
                try? llamaContext.loadModel(path: prev.localPath)
            }
            throw LocalModelError.loadFailed(error.localizedDescription)
        }

        selectedModel = model.modelId
        selectedModelParamSize = model.paramSize
        UserDefaults.standard.set(model.modelId, forKey: activeModelKey)
        state = .ready
        statusText = "\(model.modelId) ready"

        NotificationCenter.default.post(
            name: .modelDidChange,
            object: nil,
            userInfo: [
                "modelId": model.modelId,
                "paramSize": model.paramSize,
            ]
        )
    }

    // MARK: - Model Download

    func downloadModel(
        modelId: String,
        downloadUrl: URL,
        paramSize: Double,
        fileSizeBytes: Int64,
        checksumSha256: String
    ) async throws {
        state = .downloading
        statusText = "Downloading \(modelId)..."
        downloadProgress = 0

        let destinationUrl = Self.modelsDirectory.appendingPathComponent("\(modelId).gguf")

        let (tempUrl, _) = try await URLSession.shared.download(from: downloadUrl)

        let fileData = try Data(contentsOf: tempUrl)
        let computedHash = sha256Hex(data: fileData)
        guard computedHash == checksumSha256 else {
            try? FileManager.default.removeItem(at: tempUrl)
            state = .error
            statusText = "Checksum mismatch for \(modelId)"
            throw LocalModelError.checksumMismatch
        }

        try FileManager.default.moveItem(at: tempUrl, to: destinationUrl)

        let installed = InstalledModel(
            modelId: modelId,
            localPath: destinationUrl.path,
            paramSize: paramSize,
            fileSizeBytes: fileSizeBytes,
            checksumSha256: checksumSha256
        )
        installedModels.append(installed)
        saveRegistry()

        state = .ready
        statusText = "\(modelId) downloaded"
        downloadProgress = 1.0
    }

    // MARK: - Delete Model

    func deleteModel(modelId: String) {
        guard let model = installedModels.first(where: { $0.modelId == modelId }) else { return }

        if selectedModel == modelId {
            llamaContext.unloadModel()
            selectedModel = ""
            selectedModelParamSize = 0
            UserDefaults.standard.removeObject(forKey: activeModelKey)
            state = .notInstalled
            statusText = "No model active"
        }

        try? FileManager.default.removeItem(atPath: model.localPath)
        installedModels.removeAll { $0.modelId == modelId }
        saveRegistry()
    }

    // MARK: - Inference

    func runInference(prompt: String) async {
        guard llamaContext.isLoaded else {
            lastInferenceOutput = "No model loaded."
            return
        }
        do {
            let output = try await llamaContext.generate(prompt: prompt, maxTokens: 512)
            lastInferenceOutput = output
        } catch {
            lastInferenceOutput = "Error: \(error.localizedDescription)"
        }
    }

    // MARK: - SHA-256

    private func sha256Hex(data: Data) -> String {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { bytes in
            _ = CC_SHA256(bytes.baseAddress, CC_LONG(data.count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
