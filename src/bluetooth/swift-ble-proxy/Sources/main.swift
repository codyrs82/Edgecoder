/**
 * edgecoder-ble-proxy
 *
 * A CoreBluetooth Central that:
 *  - Scans for an iPhone/iPad advertising the EdgeCoder BLE service
 *  - Connects, subscribes to responseChar and statusChar
 *  - Exposes a local HTTP server on 127.0.0.1:<port>:
 *
 *      GET  /status        → BLE connection state, device info, battery, model state
 *      POST /api/generate  → { prompt, maxTokens } → runs inference on phone, returns result
 *
 * Used by the EdgeCoder IDE Provider (provider-server.ts) as the bluetooth-local backend.
 *
 * Build:
 *   cd src/bluetooth/swift-ble-proxy && swift build -c release
 *   cp .build/release/edgecoder-ble-proxy /opt/edgecoder/bin/
 *
 * Run:
 *   edgecoder-ble-proxy --port 11435
 */

import Foundation
import CoreBluetooth

// MARK: - BLE UUIDs (must match BluetoothTransport.swift on iOS)

let serviceUUID      = CBUUID(string: "EC0D0001-EC0D-EC0D-EC0D-EC0D0001EC0D")
let requestCharUUID  = CBUUID(string: "EC0D0002-EC0D-EC0D-EC0D-EC0D0002EC0D")
let responseCharUUID = CBUUID(string: "EC0D0003-EC0D-EC0D-EC0D-EC0D0003EC0D")
let statusCharUUID   = CBUUID(string: "EC0D0004-EC0D-EC0D-EC0D-EC0D0004EC0D")

// MARK: - CLI args

var port = 11435
var args = CommandLine.arguments.dropFirst()
while !args.isEmpty {
    let arg = args.removeFirst()
    if arg == "--port", let next = args.first {
        port = Int(next) ?? 11435
        args.removeFirst()
    }
}

// MARK: - Request Registry
// Maps request IDs to completion callbacks. Thread-safe via NSLock.

final class RequestRegistry {
    static let shared = RequestRegistry()
    private var callbacks = [String: ([String: Any]) -> Void]()
    private let lock = NSLock()

    func register(id: String, callback: @escaping ([String: Any]) -> Void) {
        lock.lock()
        callbacks[id] = callback
        lock.unlock()
    }

    func complete(id: String, result: [String: Any]) {
        lock.lock()
        let cb = callbacks.removeValue(forKey: id)
        lock.unlock()
        cb?(result)
    }

    func remove(id: String) {
        lock.lock()
        callbacks.removeValue(forKey: id)
        lock.unlock()
    }

    func failAll(error: String) {
        lock.lock()
        let all = callbacks
        callbacks.removeAll()
        lock.unlock()
        let errResult: [String: Any] = ["ok": false, "error": error, "output": ""]
        for (_, cb) in all { cb(errResult) }
    }
}

// MARK: - Shared state

final class BLEState {
    static let shared = BLEState()
    var connected = false
    var scanning = false
    var deviceName: String?
    var deviceId: String?
    var batteryPct: Int?
    var modelState: String = "unknown"
    var rssi: Int?
    var lastSeenMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

    // Reassembly buffer for chunked responses
    var responseBuffer = Data()

    // Current peripheral and characteristics
    var peripheral: CBPeripheral?
    var requestChar: CBCharacteristic?

    func toStatusJSON() -> [String: Any] {
        var d: [String: Any] = [
            "connected": connected,
            "scanning": scanning,
            "modelState": modelState,
            "lastSeenMs": lastSeenMs
        ]
        if let n = deviceName { d["deviceName"] = n }
        if let i = deviceId   { d["deviceId"]   = i }
        if let b = batteryPct { d["batteryPct"]  = b }
        if let r = rssi       { d["rssi"]        = r }
        return d
    }
}

// MARK: - BLE Central Manager

final class BLECentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private let state = BLEState.shared
    private let registry = RequestRegistry.shared
    private var reconnectTimer: Timer?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            print("[ble] Central powered on — scanning for EdgeCoder peripherals...")
            state.scanning = true
            central.scanForPeripherals(withServices: [serviceUUID], options: [
                CBCentralManagerScanOptionAllowDuplicatesKey: false
            ])
        case .poweredOff:
            print("[ble] Bluetooth off.")
            state.connected = false
            state.scanning = false
        case .unauthorized:
            print("[ble] Bluetooth unauthorized. Grant access in System Settings → Privacy → Bluetooth.")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
                ?? peripheral.name
                ?? "Unknown"
        print("[ble] Discovered: \(name) (RSSI=\(RSSI))")
        state.deviceName = name
        state.deviceId   = peripheral.identifier.uuidString
        state.rssi       = RSSI.intValue
        state.peripheral = peripheral
        central.stopScan()
        state.scanning = false
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        print("[ble] Connected to \(peripheral.name ?? peripheral.identifier.uuidString)")
        state.connected = true
        state.peripheral = peripheral
        peripheral.delegate = self
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        print("[ble] Disconnected: \(error?.localizedDescription ?? "clean")")
        state.connected = false
        state.requestChar = nil
        state.peripheral = nil
        state.responseBuffer = Data()
        // Fail all pending requests
        registry.failAll(error: "BLE disconnected")
        // Reconnect after 3s
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            print("[ble] Attempting reconnect...")
            self?.state.scanning = true
            central.scanForPeripherals(withServices: [serviceUUID], options: nil)
        }
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        print("[ble] Failed to connect: \(error?.localizedDescription ?? "unknown")")
        state.connected = false
        state.scanning = true
        central.scanForPeripherals(withServices: [serviceUUID], options: nil)
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let services = peripheral.services else { return }
        for service in services where service.uuid == serviceUUID {
            peripheral.discoverCharacteristics(
                [requestCharUUID, responseCharUUID, statusCharUUID],
                for: service
            )
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        guard let chars = service.characteristics else { return }
        for char in chars {
            switch char.uuid {
            case requestCharUUID:
                state.requestChar = char
                print("[ble] Found requestChar — ready to send inference requests.")
            case responseCharUUID:
                peripheral.setNotifyValue(true, for: char)
                print("[ble] Subscribed to responseChar.")
            case statusCharUUID:
                peripheral.setNotifyValue(true, for: char)
                print("[ble] Subscribed to statusChar.")
            default:
                break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard let value = characteristic.value else { return }

        if characteristic.uuid == statusCharUUID {
            if let json = try? JSONSerialization.jsonObject(with: value) as? [String: Any] {
                if let m = json["modelState"] as? String { state.modelState = m }
                if let b = json["batteryPct"]  as? Int   { state.batteryPct = b }
            }
            return
        }

        if characteristic.uuid == responseCharUUID {
            // Accumulate chunks (phone sends 512-byte chunks with 10ms pauses)
            state.responseBuffer.append(value)
            // Attempt to parse complete JSON response
            if let json = try? JSONSerialization.jsonObject(with: state.responseBuffer) as? [String: Any],
               let requestId = json["id"] as? String {
                state.responseBuffer = Data()
                // Deliver to registered callback
                registry.complete(id: requestId, result: json)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        if let error {
            print("[ble] Write error: \(error.localizedDescription)")
        }
    }

    // MARK: Send inference request

    func sendRequest(id: String, prompt: String, maxTokens: Int) throws {
        guard state.connected, let char = state.requestChar, let peripheral = state.peripheral else {
            throw NSError(domain: "BLE", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "No connected peripheral"])
        }
        let payload: [String: Any] = ["id": id, "prompt": prompt, "maxTokens": maxTokens]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            throw NSError(domain: "BLE", code: -3,
                          userInfo: [NSLocalizedDescriptionKey: "JSON serialization failed"])
        }
        // Send in 512-byte chunks (matches phone's MTU expectation)
        let chunkSize = 512
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunkSize, data.count)
            let chunk = data[offset..<end]
            peripheral.writeValue(chunk, for: char, type: .withResponse)
            offset = end
        }
    }
}

// MARK: - HTTP Server

final class HTTPServer {
    private let port: Int
    private let ble: BLECentral
    private let state = BLEState.shared
    private let registry = RequestRegistry.shared

    init(port: Int, ble: BLECentral) {
        self.port = port
        self.ble = ble
    }

    func start() {
        Thread.detachNewThread {
            self.runServer()
        }
        print("[http] BLE proxy HTTP server started on 127.0.0.1:\(self.port)")
    }

    private func runServer() {
        let socket = socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { fatalError("[http] Failed to create socket") }

        var reuseVal: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, &reuseVal, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = INADDR_ANY

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else { fatalError("[http] bind() failed on port \(port)") }
        listen(socket, 8)

        while true {
            let client = accept(socket, nil, nil)
            guard client >= 0 else { continue }
            Thread.detachNewThread { [self] in
                self.handleClient(fd: client)
            }
        }
    }

    private func handleClient(fd: Int32) {
        defer { close(fd) }
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &buffer, buffer.count)
        guard n > 0 else { return }
        let raw = String(bytes: buffer[0..<n], encoding: .utf8) ?? ""

        // Parse request line
        let lines = raw.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return }
        let method = parts[0]
        let path   = parts[1]

        // Find body (after \r\n\r\n)
        let bodyStart = raw.range(of: "\r\n\r\n").map { raw.index($0.upperBound, offsetBy: 0) }
        let bodyString = bodyStart.map { String(raw[$0...]) } ?? ""

        var responseBody: [String: Any]
        var statusCode = 200

        if path == "/status" {
            responseBody = state.toStatusJSON()
        } else if path == "/api/generate" && method == "POST" {
            responseBody = handleGenerate(bodyString: bodyString)
            if let err = responseBody["error"] as? String, !err.isEmpty {
                statusCode = 503
            }
        } else {
            responseBody = ["error": "not found"]
            statusCode = 404
        }

        let jsonData = (try? JSONSerialization.data(withJSONObject: responseBody)) ?? Data()
        let jsonStr  = String(data: jsonData, encoding: .utf8) ?? "{}"
        let httpStatus = statusCode == 200 ? "200 OK" : statusCode == 503 ? "503 Service Unavailable" : "404 Not Found"
        let response = "HTTP/1.1 \(httpStatus)\r\nContent-Type: application/json\r\nContent-Length: \(jsonStr.utf8.count)\r\nConnection: close\r\n\r\n\(jsonStr)"
        response.withCString { ptr in
            _ = write(fd, ptr, strlen(ptr))
        }
    }

    // MARK: Generate handler
    // Uses DispatchSemaphore + RequestRegistry for clean sync/async bridging.
    // The HTTP worker thread blocks on the semaphore; the BLE callback on the
    // main thread signals it when the notify arrives from the phone.

    private func handleGenerate(bodyString: String) -> [String: Any] {
        guard let bodyData = bodyString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: bodyData) as? [String: Any],
              let prompt = json["prompt"] as? String else {
            return ["ok": false, "error": "invalid request body", "output": "", "response": ""]
        }
        let maxTokens = json["maxTokens"] as? Int ?? 512
        let requestId = UUID().uuidString
        let startMs   = Int(Date().timeIntervalSince1970 * 1000)

        let sema = DispatchSemaphore(value: 0)
        var resultDict: [String: Any] = ["ok": false, "error": "timeout", "output": "", "response": ""]

        // Register callback — will be called from main thread when BLE notify fires
        registry.register(id: requestId) { result in
            resultDict = result
            sema.signal()
        }

        // Send BLE request on the main thread (CoreBluetooth requires main-thread writes)
        DispatchQueue.main.async { [self] in
            do {
                try self.ble.sendRequest(id: requestId, prompt: prompt, maxTokens: maxTokens)
            } catch {
                self.registry.remove(id: requestId)
                resultDict = ["ok": false, "error": error.localizedDescription, "output": "", "response": ""]
                sema.signal()
            }
        }

        // Block HTTP worker thread up to 90s waiting for BLE response
        let waitResult = sema.wait(timeout: .now() + 90)
        if waitResult == .timedOut {
            registry.remove(id: requestId)
            return ["ok": false, "error": "BLE request timed out", "output": "", "response": "",
                    "durationMs": 90000]
        }

        let durationMs = Int(Date().timeIntervalSince1970 * 1000) - startMs
        resultDict["durationMs"] = durationMs

        // Normalise: provider-server expects "response" key; phone sends "output"
        if let output = resultDict["output"] as? String {
            resultDict["response"] = output
        }

        return resultDict
    }
}

// MARK: - Entry Point

let ble    = BLECentral()
let server = HTTPServer(port: port, ble: ble)
server.start()

print("[edgecoder-ble-proxy] Running on 127.0.0.1:\(port)")
RunLoop.main.run()
