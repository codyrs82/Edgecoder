import XCTest

/// #64: the Swift signer must reproduce the TypeScript vectors byte for byte. The fixture lives at
/// tests/security/fixtures/request-signing-vectors.json and is also enforced by vitest
/// (tests/security/request-signing-vectors.test.ts); CI additionally runs this check with plain
/// swiftc via Scripts/request-signing-vectors.
final class RequestSigningVectorsTests: XCTestCase {
    func testSwiftSignerReproducesSharedVectors() throws {
        let fixture = try RequestSigningVectorCheck.loadFixture(at: RequestSigningVectorCheck.defaultFixtureURL())
        XCTAssertGreaterThanOrEqual(fixture.vectors.count, 3)
        XCTAssertEqual(RequestSigningVectorCheck.headerFailures(fixture.headers), [])
        for vector in fixture.vectors {
            let failures = RequestSigningVectorCheck.failures(for: vector)
            XCTAssertTrue(failures.isEmpty, "\(vector.name): \(failures.joined(separator: "; "))")
        }
    }
}
