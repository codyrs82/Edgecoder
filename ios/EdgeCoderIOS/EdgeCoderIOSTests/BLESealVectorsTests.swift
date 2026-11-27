import XCTest

/// Sealed BLE requests: `BLESeal` (Mesh/OfflineLedger.swift) must open the Node-sealed request in
/// tests/security/fixtures/ble-seal-vectors.json and seal the reply byte for byte; vitest checks the
/// same fixture against src/mesh/ble/ble-seal.ts. Also runs with plain swiftc via Scripts/ble-seal-vectors.
final class BLESealVectorsTests: XCTestCase {
    func testSwiftMatchesSharedSealVectors() throws {
        let fixture = try BLESealVectorCheck.loadFixture(at: BLESealVectorCheck.defaultFixtureURL())
        XCTAssertEqual(BLESealVectorCheck.run(fixture), [])
    }
}
