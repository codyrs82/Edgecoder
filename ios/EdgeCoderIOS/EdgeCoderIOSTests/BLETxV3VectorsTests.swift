import XCTest

/// #63: `BLETxV3` (Mesh/OfflineLedger.swift) must reproduce the shared BLE credit-transaction
/// vectors in tests/security/fixtures/ble-tx-v3-vectors.json byte for byte; the same fixture is
/// enforced by vitest (tests/security/ble-tx-v3-vectors.test.ts). CI can also run this check with
/// plain swiftc via Scripts/ble-tx-v3-vectors.
final class BLETxV3VectorsTests: XCTestCase {
    func testSwiftCanonicalBytesMatchSharedVectors() throws {
        let fixture = try BLETxV3VectorCheck.loadFixture(at: BLETxV3VectorCheck.defaultFixtureURL())
        let result = BLETxV3VectorCheck.run(fixture)
        XCTAssertEqual(result.failures, [])
        XCTAssertEqual(result.signed.count, fixture.vectors.count)
    }

    func testNewlineInAnyStringFieldIsRefused() {
        let ok = BLETxV3Fields(txId: "t", requesterId: "r", requesterAccountId: "ra", providerId: "p",
                               providerAccountId: "pa", taskHash: "h", cpuMillis: 1, creditMillis: 1)
        XCTAssertNoThrow(try BLETxV3.canonicalBytes(ok))
        let bad = BLETxV3Fields(txId: "t", requesterId: "r\r\n", requesterAccountId: "ra", providerId: "p",
                                providerAccountId: "pa", taskHash: "h", cpuMillis: 1, creditMillis: 1)
        XCTAssertThrowsError(try BLETxV3.canonicalBytes(bad))
    }
}
