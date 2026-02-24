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

    private let modelManager: LocalModelManager
    private let swarmRuntime: SwarmRuntimeController
    private let bleMeshManager: BLEMeshManager

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

    func routeChat(messages: [ChatMessage]) async -> ChatRouteResult {
        let started = CFAbsoluteTimeGetCurrent()
        let lastUserContent = messages.last(where: { $0.role == .user })?.content ?? ""

        // 1. Local llama.cpp — if model is loaded and within capacity
        if modelManager.state == .ready && activeConcurrent < concurrencyCap {
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

        // 2. BLE peer — if a nearby peer is discovered
        if let peer = bleMeshManager.discoveredPeers.first {
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
                let swarmResult = try await swarmRuntime.submitChatTask(prompt: lastUserContent)
                let elapsed = Int((CFAbsoluteTimeGetCurrent() - started) * 1000)
                let routeResult = ChatRouteResult(
                    route: .swarm,
                    text: swarmResult.output,
                    model: "swarm",
                    latencyMs: elapsed,
                    creditsSpent: 5,
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

    // MARK: - Route Chat (streaming)

    func routeChatStreaming(messages: [ChatMessage]) -> AsyncThrowingStream<String, Error> {
        let lastUserContent = messages.last(where: { $0.role == .user })?.content ?? ""

        // Streaming only supported via local model
        if modelManager.state == .ready {
            return modelManager.generateStreaming(prompt: lastUserContent, maxTokens: 512)
        }

        // Fall back to non-streaming wrapped as stream
        return AsyncThrowingStream { continuation in
            Task { @MainActor in
                let result = await self.routeChat(messages: messages)
                continuation.yield(result.text)
                continuation.finish()
            }
        }
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
