import Foundation

// MARK: - Latency Tracker (EMA)

private final class LatencyTracker {
    private var ema: Double = 0
    private var samples = 0
    private let alpha = 0.2

    func record(ms: Int) {
        let value = Double(ms)
        if samples == 0 {
            ema = value
        } else {
            ema = alpha * value + (1 - alpha) * ema
        }
        samples += 1
    }

    var p95EstimateMs: Int {
        samples < 3 ? 0 : Int(ema * 1.8)
    }

    var sampleCount: Int { samples }
}

// MARK: - ChatRouter

@MainActor
final class ChatRouter: ObservableObject {
    @Published var lastRoute: RouteDecision?
    @Published var lastLatencyMs: Int = 0

    private let latency = LatencyTracker()
    private var activeConcurrent = 0
    private let concurrencyCap = 1 // iOS devices: single concurrent inference
    private let latencyThresholdMs = 15_000 // More lenient for mobile

    let modelManager: LocalModelManager
    let swarmRuntime: SwarmRuntimeController
    let bleMeshManager: BLEMeshManager

    init(
        modelManager: LocalModelManager,
        swarmRuntime: SwarmRuntimeController,
        bleMeshManager: BLEMeshManager
    ) {
        self.modelManager = modelManager
        self.swarmRuntime = swarmRuntime
        self.bleMeshManager = bleMeshManager
    }

    // MARK: - Route Chat (non-streaming)

    func routeChat(messages: [ChatMessage], requestedModel: String? = nil) async -> ChatRouteResult {
        let started = CFAbsoluteTimeGetCurrent()
        let lastUserContent = messages.last(where: { $0.role == .user })?.content ?? ""

        // 1. Local llama.cpp — if model is loaded and within capacity
        if modelManager.state == .ready && activeConcurrent < concurrencyCap {
            // Skip local if user requested a different model
            let localModelMatches = requestedModel == nil || requestedModel == modelManager.selectedModel
            if localModelMatches {
                let p95 = latency.p95EstimateMs
                if p95 == 0 || p95 <= latencyThresholdMs {
                    activeConcurrent += 1
                    let t0 = CFAbsoluteTimeGetCurrent()
                    let result = await modelManager.generate(prompt: lastUserContent, maxTokens: 512)
                    let elapsed = Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)
                    latency.record(ms: elapsed)
                    activeConcurrent = max(0, activeConcurrent - 1)

                    if result.ok {
                        let routeResult = ChatRouteResult(
                            route: .local,
                            text: result.output,
                            model: modelManager.selectedModel,
                            latencyMs: elapsed,
                            creditsSpent: nil,
                            swarmTaskId: nil
                        )
                        lastRoute = .local
                        lastLatencyMs = elapsed
                        return routeResult
                    }
                }
            }
        }

        // 2. BLE peer — if a nearby peer is discovered
        let matchingPeer = requestedModel != nil
            ? bleMeshManager.discoveredPeers.first(where: { $0.model == requestedModel })
            : bleMeshManager.discoveredPeers.first
        if let peer = matchingPeer {
            let bleResult = await bleMeshManager.sendTask(
                toAgentId: peer.agentId,
                prompt: lastUserContent,
                tag: "chat"
            )
            if bleResult.ok {
                let elapsed = Int((CFAbsoluteTimeGetCurrent() - started) * 1000)
                let routeResult = ChatRouteResult(
                    route: .blePeer,
                    text: bleResult.output,
                    model: "ble-\(peer.agentId)",
                    latencyMs: elapsed,
                    creditsSpent: nil,
                    swarmTaskId: nil
                )
                lastRoute = .blePeer
                lastLatencyMs = elapsed
                return routeResult
            }
        }

        // 3. Coordinator/swarm — submit to task queue
        if !swarmRuntime.meshToken.isEmpty {
            do {
                let swarmResult = try await swarmRuntime.submitChatTask(prompt: lastUserContent, requestedModel: requestedModel)
                let elapsed = Int((CFAbsoluteTimeGetCurrent() - started) * 1000)
                let paramSize: Double
                if let catalog = modelManager.availableCatalog.first(where: { $0.modelId == requestedModel }) {
                    paramSize = catalog.paramSize
                } else {
                    paramSize = 1.0
                }
                let routeResult = ChatRouteResult(
                    route: .swarm,
                    text: swarmResult.output,
                    model: "swarm",
                    latencyMs: elapsed,
                    creditsSpent: Int(max(0.5, paramSize)),
                    swarmTaskId: swarmResult.taskId
                )
                lastRoute = .swarm
                lastLatencyMs = elapsed
                return routeResult
            } catch {
                print("[ChatRouter] swarm failed: \(error.localizedDescription)")
            }
        }

        // 4. Offline stub
        let elapsed = Int((CFAbsoluteTimeGetCurrent() - started) * 1000)
        lastRoute = .offlineStub
        lastLatencyMs = elapsed
        return ChatRouteResult(
            route: .offlineStub,
            text: "I'm currently offline \u{2014} no local model is loaded and no swarm peers are reachable. Please download a model in Settings or connect to the EdgeCoder network.",
            model: "offline-stub",
            latencyMs: elapsed,
            creditsSpent: nil,
            swarmTaskId: nil
        )
    }

    // MARK: - Route Chat (streaming with progress)

    /// Streaming result that yields token strings. Call `progress()` to get current stats.
    struct StreamingSession {
        let tokens: AsyncThrowingStream<String, Error>
        let getProgress: () -> StreamProgress
    }

    func routeChatStreaming(messages: [ChatMessage], requestedModel: String? = nil) -> StreamingSession {
        let lastUserContent = messages.last(where: { $0.role == .user })?.content ?? ""
        let startTime = CFAbsoluteTimeGetCurrent()
        var tokenCount = 0
        var routeDecision: RouteDecision = .offlineStub
        var routeLabel = "offline"
        var modelName = ""

        let routeLabels: [RouteDecision: String] = [
            .local: "local model",
            .blePeer: "nearby device",
            .swarm: "swarm network",
            .offlineStub: "offline",
        ]

        // Determine route before streaming
        if modelManager.state == .ready {
            let localModelMatches = requestedModel == nil || requestedModel == modelManager.selectedModel
            if localModelMatches {
                routeDecision = .local
                routeLabel = routeLabels[.local] ?? "local"
                modelName = modelManager.selectedModel
            }
        }
        // Only check BLE if we haven't found a route yet
        if routeDecision == .offlineStub && !bleMeshManager.discoveredPeers.isEmpty {
            let matchingPeer = requestedModel != nil
                ? bleMeshManager.discoveredPeers.first(where: { $0.model == requestedModel })
                : bleMeshManager.discoveredPeers.first
            if matchingPeer != nil {
                routeDecision = .blePeer
                routeLabel = routeLabels[.blePeer] ?? "peer"
                modelName = "ble-\(matchingPeer!.agentId)"
            }
        }
        if routeDecision == .offlineStub && !swarmRuntime.meshToken.isEmpty {
            routeDecision = .swarm
            routeLabel = routeLabels[.swarm] ?? "swarm"
            modelName = "swarm"
        }

        let progress: () -> StreamProgress = {
            let paramSize: Double
            if routeDecision == .local {
                paramSize = self.modelManager.selectedModelParamSize
            } else if let catalog = self.modelManager.availableCatalog.first(where: { $0.modelId == requestedModel }) {
                paramSize = catalog.paramSize
            } else {
                paramSize = 1.0
            }
            return StreamProgress(
                tokenCount: tokenCount,
                elapsedMs: Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000),
                route: routeDecision,
                routeLabel: routeLabel,
                model: modelName,
                creditsSpent: routeDecision == .swarm ? max(0.5, paramSize) : nil
            )
        }

        // Streaming via local model
        if routeDecision == .local {
            let innerStream = modelManager.generateStreaming(prompt: lastUserContent, maxTokens: 512)
            let wrappedStream = AsyncThrowingStream<String, Error> { continuation in
                Task {
                    do {
                        for try await chunk in innerStream {
                            tokenCount += 1
                            continuation.yield(chunk)
                        }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                    }
                }
            }
            return StreamingSession(tokens: wrappedStream, getProgress: progress)
        }

        // Fall back to non-streaming wrapped as stream
        let fallbackStream = AsyncThrowingStream<String, Error> { continuation in
            Task { @MainActor [self] in
                let result = await self.routeChat(messages: messages, requestedModel: requestedModel)
                routeDecision = result.route
                routeLabel = routeLabels[result.route] ?? result.route.rawValue
                modelName = result.model
                // Simulate token-by-token for the progress counter
                let words = result.text.split(separator: " ")
                for word in words {
                    tokenCount += 1
                    continuation.yield(String(word) + " ")
                }
                continuation.finish()
            }
        }
        return StreamingSession(tokens: fallbackStream, getProgress: progress)
    }

    // MARK: - Status

    var status: [String: Any] {
        [
            "activeConcurrent": activeConcurrent,
            "concurrencyCap": concurrencyCap,
            "localLatencyP95Ms": latency.p95EstimateMs,
            "latencyThresholdMs": latencyThresholdMs,
            "latencySamples": latency.sampleCount,
            "modelLoaded": modelManager.state == .ready,
            "activeModel": modelManager.selectedModel,
            "blePeers": bleMeshManager.discoveredPeers.count,
            "swarmEnabled": !swarmRuntime.meshToken.isEmpty
        ]
    }
}
