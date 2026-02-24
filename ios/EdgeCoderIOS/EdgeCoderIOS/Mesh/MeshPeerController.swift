// MeshPeerController.swift
// EdgeCoderIOS
//
// iOS-native MeshPeer — manages the peer table, bootstrap against seed URLs,
// periodic peer exchange, and message dispatch. This makes the iPhone a full
// participant in the BitTorrent-style mesh alongside coordinators and Mac agents.

import Foundation

/// Entry in the local peer table.
struct MeshPeerEntry: Sendable {
    let peerId: String
    let publicKeyPem: String
    let coordinatorUrl: String
    let networkMode: String
    var role: String
    var lastSeenMs: Int
}

/// Configuration for MeshPeerController.
struct MeshPeerConfig {
    let peerId: String
    let keyPair: Ed25519KeyPair
    let networkMode: String
    let role: String
    var meshToken: String?
}

/// Handler type for incoming mesh messages.
typealias MeshMessageHandler = @Sendable ([String: Any]) async -> Void

final class MeshPeerController: @unchecked Sendable {
    private let config: MeshPeerConfig
    private let httpServer: MeshHTTPServer
    private var peerTable: [String: MeshPeerEntry] = [:]
    private var messageHandlers: [String: [MeshMessageHandler]] = [:]
    private var peerExchangeTimer: Timer?
    private var peerEvictionTimer: Timer?
    private var publicUrl: String = ""
    private let lock = NSLock()

    private let peerExchangeIntervalSec: TimeInterval = 30
    private let peerTtlMs: Int = 120_000
    private let maxPeerExchangeEntries = 50

    /// Published peer count for SwiftUI observation.
    var peerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return peerTable.count
    }

    var listeningPort: UInt16 { httpServer.listeningPort }

    init(config: MeshPeerConfig) {
        self.config = config
        self.httpServer = MeshHTTPServer(meshToken: config.meshToken)

        // Wire up HTTP server handlers
        httpServer.onIngest = { [weak self] body in
            await self?.handleIngest(body) ?? ["error": "controller_gone"]
        }
        httpServer.onRegisterPeer = { [weak self] body in
            self?.handleRegisterPeer(body) ?? ["error": "controller_gone"]
        }
        httpServer.peersProvider = { [weak self] in
            self?.listPeersAsDict() ?? []
        }
    }

    // MARK: - Lifecycle

    func start(port: UInt16 = 0) throws {
        try httpServer.start(port: port)

        // Wait briefly for port to be assigned
        Thread.sleep(forTimeInterval: 0.1)

        let ip = NetworkUtils.getLocalIPAddress() ?? "127.0.0.1"
        publicUrl = "http://\(ip):\(httpServer.listeningPort)"

        // Set identity on HTTP server
        httpServer.identity = [
            "peerId": config.peerId,
            "publicKeyPem": config.keyPair.publicKeyPem,
            "coordinatorUrl": publicUrl,
            "networkMode": config.networkMode,
            "role": config.role,
        ]

        print("[MeshPeer] started at \(publicUrl)")
    }

    func stop() {
        peerExchangeTimer?.invalidate()
        peerExchangeTimer = nil
        peerEvictionTimer?.invalidate()
        peerEvictionTimer = nil
        httpServer.stop()
    }

    // MARK: - Bootstrap

    /// Bootstrap from seed URLs — contact each, register, learn their peers.
    func bootstrap(seedUrls: [String]) async {
        for seedUrl in seedUrls {
            do {
                // Step 1: GET /identity from seed
                guard let remoteIdentity = try await httpGet(url: "\(seedUrl)/identity") else { continue }
                guard let remotePeerId = remoteIdentity["peerId"] as? String,
                      remotePeerId != config.peerId else { continue }

                // Step 2: Register ourselves with seed
                let registerBody: [String: Any] = [
                    "peerId": config.peerId,
                    "publicKeyPem": config.keyPair.publicKeyPem,
                    "coordinatorUrl": publicUrl,
                    "networkMode": config.networkMode,
                    "role": config.role,
                ]
                _ = try await httpPost(url: "\(seedUrl)/mesh/register-peer", body: registerBody)

                // Add seed to our peer table
                addPeer(MeshPeerEntry(
                    peerId: remotePeerId,
                    publicKeyPem: remoteIdentity["publicKeyPem"] as? String ?? "",
                    coordinatorUrl: seedUrl,
                    networkMode: remoteIdentity["networkMode"] as? String ?? "public_mesh",
                    role: remoteIdentity["role"] as? String ?? "coordinator",
                    lastSeenMs: currentMs()
                ))

                // Step 3: GET /mesh/peers from seed
                if let peersResponse = try? await httpGet(url: "\(seedUrl)/mesh/peers"),
                   let peers = peersResponse["peers"] as? [[String: Any]] {
                    for p in peers {
                        guard let pId = p["peerId"] as? String, pId != config.peerId else { continue }
                        addPeer(MeshPeerEntry(
                            peerId: pId,
                            publicKeyPem: p["publicKeyPem"] as? String ?? "",
                            coordinatorUrl: p["coordinatorUrl"] as? String ?? "",
                            networkMode: p["networkMode"] as? String ?? "public_mesh",
                            role: p["role"] as? String ?? "coordinator",
                            lastSeenMs: currentMs()
                        ))
                    }
                }

                // Step 4: Register with each discovered peer
                let peers = listPeers()
                for peer in peers where peer.peerId != remotePeerId {
                    _ = try? await httpPost(
                        url: "\(peer.coordinatorUrl)/mesh/register-peer",
                        body: registerBody
                    )
                }

                print("[MeshPeer] bootstrapped from \(seedUrl), \(peerCount) peers known")
            } catch {
                print("[MeshPeer] bootstrap \(seedUrl) failed: \(error.localizedDescription)")
            }
        }

        startPeerExchange()
        startPeerEviction()
    }

    // MARK: - Message Handlers

    /// Register a handler for a specific message type.
    func on(_ type: String, handler: @escaping MeshMessageHandler) {
        lock.lock()
        var handlers = messageHandlers[type] ?? []
        handlers.append(handler)
        messageHandlers[type] = handlers
        lock.unlock()
    }

    // MARK: - Broadcasting

    /// Create a signed message and broadcast to all peers.
    func broadcast(type: String, payload: [String: Any], ttlMs: Int = 30_000) async {
        let message = createMessage(type: type, payload: payload, ttlMs: ttlMs)
        let peers = listPeers()
        await withTaskGroup(of: Void.self) { group in
            for peer in peers {
                group.addTask { [weak self] in
                    _ = try? await self?.httpPost(
                        url: "\(peer.coordinatorUrl)/mesh/ingest",
                        body: message
                    )
                }
            }
        }
    }

    // MARK: - Peer Table

    func addPeer(_ entry: MeshPeerEntry) {
        guard entry.peerId != config.peerId else { return }
        lock.lock()
        peerTable[entry.peerId] = entry
        lock.unlock()
    }

    func removePeer(_ peerId: String) {
        lock.lock()
        peerTable.removeValue(forKey: peerId)
        lock.unlock()
    }

    func getPeer(_ peerId: String) -> MeshPeerEntry? {
        lock.lock()
        defer { lock.unlock() }
        return peerTable[peerId]
    }

    func listPeers() -> [MeshPeerEntry] {
        lock.lock()
        defer { lock.unlock() }
        return Array(peerTable.values)
    }

    // MARK: - Private: Ingest Handling

    private func handleIngest(_ body: [String: Any]) async -> [String: Any] {
        guard let fromPeerId = body["fromPeerId"] as? String,
              let type = body["type"] as? String else {
            return ["error": "invalid_message"]
        }

        // Skip own messages
        if fromPeerId == config.peerId {
            return ["ok": true, "reason": "own_message"]
        }

        // Update lastSeen for known peers
        lock.lock()
        if var peer = peerTable[fromPeerId] {
            peer.lastSeenMs = currentMs()
            peerTable[fromPeerId] = peer
        }
        lock.unlock()

        // Handle peer_exchange internally
        if type == "peer_exchange" {
            handlePeerExchange(body)
        }

        // Dispatch to registered handlers
        lock.lock()
        let handlers = messageHandlers[type] ?? []
        lock.unlock()

        for handler in handlers {
            await handler(body)
        }

        return ["ok": true]
    }

    private func handleRegisterPeer(_ body: [String: Any]) -> [String: Any] {
        guard let peerId = body["peerId"] as? String,
              peerId != config.peerId else {
            return ["ok": true]
        }
        addPeer(MeshPeerEntry(
            peerId: peerId,
            publicKeyPem: body["publicKeyPem"] as? String ?? "",
            coordinatorUrl: body["coordinatorUrl"] as? String ?? "",
            networkMode: body["networkMode"] as? String ?? "public_mesh",
            role: body["role"] as? String ?? "agent",
            lastSeenMs: currentMs()
        ))
        return ["ok": true, "peerCount": peerCount]
    }

    private func handlePeerExchange(_ body: [String: Any]) {
        guard let payload = body["payload"] as? [String: Any],
              let peers = payload["peers"] as? [[String: Any]] else { return }
        for p in peers {
            guard let peerId = p["peerId"] as? String, peerId != config.peerId else { continue }
            lock.lock()
            let existing = peerTable[peerId]
            lock.unlock()
            if existing == nil {
                addPeer(MeshPeerEntry(
                    peerId: peerId,
                    publicKeyPem: p["publicKeyPem"] as? String ?? "",
                    coordinatorUrl: p["peerUrl"] as? String ?? "",
                    networkMode: p["networkMode"] as? String ?? "public_mesh",
                    role: p["role"] as? String ?? "coordinator",
                    lastSeenMs: p["lastSeenMs"] as? Int ?? currentMs()
                ))
            } else {
                lock.lock()
                if let seen = p["lastSeenMs"] as? Int, var entry = peerTable[peerId] {
                    entry.lastSeenMs = max(entry.lastSeenMs, seen)
                    peerTable[peerId] = entry
                }
                lock.unlock()
            }
        }
    }

    // MARK: - Private: Peer Exchange Timer

    private func startPeerExchange() {
        DispatchQueue.main.async { [weak self] in
            self?.peerExchangeTimer = Timer.scheduledTimer(
                withTimeInterval: self?.peerExchangeIntervalSec ?? 30,
                repeats: true
            ) { [weak self] _ in
                Task { await self?.broadcastPeerExchange() }
            }
        }
    }

    private func broadcastPeerExchange() async {
        let entries = listPeers()
            .sorted(by: { $0.lastSeenMs > $1.lastSeenMs })
            .prefix(maxPeerExchangeEntries)

        let payload: [String: Any] = [
            "peers": entries.map { e -> [String: Any] in
                [
                    "peerId": e.peerId,
                    "publicKeyPem": e.publicKeyPem,
                    "peerUrl": e.coordinatorUrl,
                    "networkMode": e.networkMode,
                    "role": e.role,
                    "lastSeenMs": e.lastSeenMs,
                ]
            }
        ]

        await broadcast(type: "peer_exchange", payload: payload)
    }

    // MARK: - Private: Peer Eviction

    private func startPeerEviction() {
        DispatchQueue.main.async { [weak self] in
            self?.peerEvictionTimer = Timer.scheduledTimer(
                withTimeInterval: 60,
                repeats: true
            ) { [weak self] _ in
                self?.evictStalePeers()
            }
        }
    }

    private func evictStalePeers() {
        let now = currentMs()
        lock.lock()
        let stale = peerTable.filter { now - $0.value.lastSeenMs > peerTtlMs }
        for key in stale.keys {
            peerTable.removeValue(forKey: key)
        }
        lock.unlock()
        if !stale.isEmpty {
            print("[MeshPeer] evicted \(stale.count) stale peers, \(peerCount) remaining")
        }
    }

    // MARK: - Private: Message Creation

    private func createMessage(type: String, payload: [String: Any], ttlMs: Int) -> [String: Any] {
        let id = UUID().uuidString
        let issuedAtMs = currentMs()

        // Canonical payload for signing
        let sigPayload: [String: Any] = [
            "id": id,
            "type": type,
            "fromPeerId": config.peerId,
            "issuedAtMs": issuedAtMs,
            "ttlMs": ttlMs,
            "payload": payload,
        ]
        let sigData = (try? JSONSerialization.data(
            withJSONObject: sigPayload,
            options: [.sortedKeys]
        )) ?? Data()
        let signature = (try? config.keyPair.signPayload(String(data: sigData, encoding: .utf8) ?? "")) ?? ""

        return [
            "id": id,
            "type": type,
            "fromPeerId": config.peerId,
            "issuedAtMs": issuedAtMs,
            "ttlMs": ttlMs,
            "payload": payload,
            "signature": signature,
        ]
    }

    // MARK: - Private: HTTP Helpers

    private func httpGet(url urlString: String) async throws -> [String: Any]? {
        guard let url = URL(string: urlString) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 8
        if let token = config.meshToken, !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "x-mesh-token")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return nil
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func httpPost(url urlString: String, body: [String: Any]) async throws -> [String: Any]? {
        guard let url = URL(string: urlString) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = config.meshToken, !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "x-mesh-token")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            return nil
        }
        if data.isEmpty { return [:] }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func listPeersAsDict() -> [[String: Any]] {
        listPeers().map { e in
            [
                "peerId": e.peerId,
                "publicKeyPem": e.publicKeyPem,
                "coordinatorUrl": e.coordinatorUrl,
                "networkMode": e.networkMode,
                "role": e.role,
            ]
        }
    }

    private func currentMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }
}
