// MeshHTTPServer.swift
// EdgeCoderIOS
//
// Lightweight HTTP/1.1 server using Network.framework (NWListener).
// Exposes mesh peer endpoints: GET /identity, GET /mesh/peers,
// POST /mesh/register-peer, POST /mesh/ingest.
// Works in iOS background modes without third-party dependencies.

import Network
import Foundation

/// Handler for ingest messages — called when POST /mesh/ingest receives a gossip message.
typealias MeshIngestHandler = @Sendable ([String: Any]) async -> [String: Any]
/// Handler for peer registration — called when POST /mesh/register-peer receives a new peer.
typealias MeshRegisterPeerHandler = @Sendable ([String: Any]) async -> [String: Any]

final class MeshHTTPServer: @unchecked Sendable {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "io.edgecoder.meshhttp", qos: .userInitiated)
    private(set) var listeningPort: UInt16 = 0
    private let meshToken: String?

    // Identity returned by GET /identity
    var identity: [String: Any] = [:]
    // Peers returned by GET /mesh/peers
    var peersProvider: (() -> [[String: Any]])?

    var onIngest: MeshIngestHandler?
    var onRegisterPeer: MeshRegisterPeerHandler?

    init(meshToken: String?) {
        self.meshToken = meshToken
    }

    func start(port: UInt16 = 0) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let nwPort: NWEndpoint.Port = port == 0 ? .any : NWEndpoint.Port(rawValue: port)!
        listener = try NWListener(using: params, on: nwPort)

        listener?.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener?.port?.rawValue {
                    self?.listeningPort = port
                    print("[MeshHTTPServer] listening on port \(port)")
                }
            case .failed(let error):
                print("[MeshHTTPServer] listener failed: \(error)")
                self?.listener?.cancel()
            default:
                break
            }
        }

        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener?.start(queue: queue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
        listeningPort = 0
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHTTPRequest(connection: connection)
    }

    private func receiveHTTPRequest(connection: NWConnection) {
        // Read up to 64KB for the full HTTP request
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let self, let data, error == nil else {
                connection.cancel()
                return
            }
            guard let raw = String(data: data, encoding: .utf8) else {
                self.sendResponse(connection: connection, status: 400, body: ["error": "invalid_encoding"])
                return
            }
            self.routeRequest(connection: connection, raw: raw)
        }
    }

    private func routeRequest(connection: NWConnection, raw: String) {
        // Parse HTTP request line
        let lines = raw.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            sendResponse(connection: connection, status: 400, body: ["error": "bad_request"])
            return
        }
        let parts = requestLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2 else {
            sendResponse(connection: connection, status: 400, body: ["error": "bad_request"])
            return
        }
        let method = String(parts[0])
        let path = String(parts[1])

        // Parse headers
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { break }
            if let colonIndex = line.firstIndex(of: ":") {
                let key = line[line.startIndex..<colonIndex].trimmingCharacters(in: .whitespaces).lowercased()
                let value = line[line.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
                headers[key] = value
            }
        }

        // Auth check for mesh-protected endpoints
        let protectedPaths = ["/mesh/peers", "/mesh/register-peer", "/mesh/ingest"]
        if protectedPaths.contains(path) {
            if let token = meshToken, !token.isEmpty {
                guard headers["x-mesh-token"] == token else {
                    sendResponse(connection: connection, status: 401, body: ["error": "mesh_unauthorized"])
                    return
                }
            }
        }

        // Parse body (after empty line)
        var body: [String: Any]?
        if let emptyLineIndex = raw.range(of: "\r\n\r\n") {
            let bodyString = String(raw[emptyLineIndex.upperBound...])
            if let bodyData = bodyString.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any] {
                body = parsed
            }
        }

        // Route
        switch (method, path) {
        case ("GET", "/identity"):
            sendResponse(connection: connection, status: 200, body: identity)

        case ("GET", "/mesh/peers"):
            let peers = peersProvider?() ?? []
            sendResponse(connection: connection, status: 200, body: ["peers": peers])

        case ("POST", "/mesh/register-peer"):
            guard let body else {
                sendResponse(connection: connection, status: 400, body: ["error": "missing_body"])
                return
            }
            if let handler = onRegisterPeer {
                Task {
                    let result = await handler(body)
                    self.sendResponse(connection: connection, status: 200, body: result)
                }
            } else {
                sendResponse(connection: connection, status: 200, body: ["ok": true])
            }

        case ("POST", "/mesh/ingest"):
            guard let body else {
                sendResponse(connection: connection, status: 400, body: ["error": "missing_body"])
                return
            }
            if let handler = onIngest {
                Task {
                    let result = await handler(body)
                    let status = (result["error"] != nil) ? 400 : 200
                    self.sendResponse(connection: connection, status: status, body: result)
                }
            } else {
                sendResponse(connection: connection, status: 200, body: ["ok": true])
            }

        default:
            sendResponse(connection: connection, status: 404, body: ["error": "not_found"])
        }
    }

    // MARK: - Response

    private func sendResponse(connection: NWConnection, status: Int, body: Any) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 429: statusText = "Too Many Requests"
        default: statusText = "Error"
        }

        let jsonData: Data
        if let dict = body as? [String: Any] {
            jsonData = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data()
        } else if let arr = body as? [[String: Any]] {
            jsonData = (try? JSONSerialization.data(withJSONObject: arr)) ?? Data()
        } else {
            jsonData = Data()
        }

        let header = [
            "HTTP/1.1 \(status) \(statusText)",
            "Content-Type: application/json",
            "Content-Length: \(jsonData.count)",
            "Connection: close",
            "",
            ""
        ].joined(separator: "\r\n")

        var responseData = Data(header.utf8)
        responseData.append(jsonData)

        connection.send(content: responseData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
