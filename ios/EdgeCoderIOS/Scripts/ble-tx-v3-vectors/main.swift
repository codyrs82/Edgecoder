import Foundation

// Command-line runner for the shared BLE tx v3 vectors (#63). Built with plain swiftc (no Xcode):
//   swiftc -o check EdgeCoderIOS/Mesh/OfflineLedger.swift \
//     EdgeCoderIOSTests/BLETxV3VectorCheck.swift Scripts/ble-tx-v3-vectors/main.swift
//   ./check ../../tests/security/fixtures/ble-tx-v3-vectors.json swift-ble-signed.json
//   node Scripts/ble-tx-v3-vectors/verify-with-node.mjs ../../tests/security/fixtures/ble-tx-v3-vectors.json swift-ble-signed.json

let arguments = CommandLine.arguments
let fixtureURL = arguments.count > 1 ? URL(fileURLWithPath: arguments[1]) : BLETxV3VectorCheck.defaultFixtureURL()

let fixture: BLETxV3Fixture
do {
    fixture = try BLETxV3VectorCheck.loadFixture(at: fixtureURL)
} catch {
    print("FAIL: could not load \(fixtureURL.path): \(error)")
    exit(1)
}

let (failures, signed) = BLETxV3VectorCheck.run(fixture)
for failure in failures { print("FAIL \(failure)") }
for entry in signed { print("ok   \(entry.name)") }
print("ok   \(fixture.invalid.count) invalid cases refused, \(fixture.creditMillis.count) credit rows match")

if arguments.count > 2 {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    do {
        try encoder.encode(signed).write(to: URL(fileURLWithPath: arguments[2]))
    } catch {
        print("FAIL: could not write \(arguments[2]): \(error)")
        exit(1)
    }
}
exit(failures.isEmpty ? 0 : 1)
