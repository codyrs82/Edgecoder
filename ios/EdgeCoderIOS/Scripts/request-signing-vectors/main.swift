import CryptoKit
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

// Optional second argument: write the headers the Swift signer produces for each vector, so CI can
// verify them with Node's crypto.verify (the coordinator's verifier) via verify-with-node.mjs.
if arguments.count > 2 {
    var emitted: [[String: String]] = []
    for vector in fixture.vectors {
        guard let seed = RequestSigningVectorCheck.hexData(vector.privateKeySeedHex),
              let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed),
              let headers = try? RequestSigner.sign(
                  method: vector.method, path: vector.path, body: Data(vector.body.utf8),
                  agentId: vector.agentId, privateKey: key,
                  timestampMs: vector.timestampMs, nonce: vector.nonce) else {
            failed = true
            print("FAIL \(vector.name): could not sign for emit")
            continue
        }
        var entry = headers.headerFields
        entry["name"] = vector.name
        emitted.append(entry)
    }
    do {
        let data = try JSONSerialization.data(withJSONObject: emitted, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: arguments[2]))
        print("wrote \(emitted.count) Swift-signed header sets to \(arguments[2])")
    } catch {
        failed = true
        print("FAIL: could not write \(arguments[2]): \(error)")
    }
}
exit(failed ? 1 : 0)
