import Foundation

// Command-line runner for the shared request-signing vectors (#64). Built in CI (ios-build job)
// with plain swiftc so the Swift canonicalisation is checked even without an Xcode test target:
//   swiftc -o check EdgeCoderIOS/Security/RequestSigner.swift \
//     EdgeCoderIOSTests/RequestSigningVectorCheck.swift Scripts/request-signing-vectors/main.swift
//   ./check ../../tests/security/fixtures/request-signing-vectors.json

let arguments = CommandLine.arguments
let fixtureURL = arguments.count > 1
    ? URL(fileURLWithPath: arguments[1])
    : RequestSigningVectorCheck.defaultFixtureURL()

let fixture: RequestSigningFixture
do {
    fixture = try RequestSigningVectorCheck.loadFixture(at: fixtureURL)
} catch {
    print("FAIL: could not load \(fixtureURL.path): \(error)")
    exit(1)
}

var failed = false
let headerFailures = RequestSigningVectorCheck.headerFailures(fixture.headers)
if !headerFailures.isEmpty {
    failed = true
    print("FAIL headers: \(headerFailures.joined(separator: "; "))")
}
if fixture.vectors.count < 3 {
    failed = true
    print("FAIL: expected at least 3 vectors, found \(fixture.vectors.count)")
}
for vector in fixture.vectors {
    let failures = RequestSigningVectorCheck.failures(for: vector)
    if failures.isEmpty {
        print("ok   \(vector.name)")
    } else {
        failed = true
        print("FAIL \(vector.name): \(failures.joined(separator: "; "))")
    }
}
exit(failed ? 1 : 0)
