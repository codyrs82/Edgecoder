import Foundation

// Command-line runner for the shared sealed-BLE vectors. Built with plain swiftc (no Xcode):
//   swiftc -o check EdgeCoderIOS/Mesh/OfflineLedger.swift \
//     EdgeCoderIOSTests/BLESealVectorCheck.swift Scripts/ble-seal-vectors/main.swift
//   ./check ../../tests/security/fixtures/ble-seal-vectors.json

let arguments = CommandLine.arguments
let url = arguments.count > 1 ? URL(fileURLWithPath: arguments[1]) : BLESealVectorCheck.defaultFixtureURL()
do {
    let failures = BLESealVectorCheck.run(try BLESealVectorCheck.loadFixture(at: url))
    for failure in failures { print("FAIL \(failure)") }
    if !failures.isEmpty { exit(1) }
    print("ok   sealed request opens, reply seals byte for byte, wrong key and tampering refused")
} catch {
    print("FAIL: could not load \(url.path): \(error)")
    exit(1)
}
