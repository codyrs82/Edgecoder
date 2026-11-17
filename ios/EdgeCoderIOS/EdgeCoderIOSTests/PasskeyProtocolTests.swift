import AuthenticationServices
import XCTest

/// A fake portal: answers by path, records every request (with its body) for assertions.
final class MockPortalProtocol: URLProtocol {
    struct Answer { let status: Int; let body: String }
    static var answers: [String: Answer] = [:]
    static var requests: [(path: String, body: Data)] = []

    static func reset() { answers = [:]; requests = [] }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read) ?? Data()
        Self.requests.append((path, body))
        let answer = Self.answers[path] ?? Answer(status: 404, body: #"{"error":"not_found"}"#)
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(answer.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

final class PasskeyProtocolTests: XCTestCase {
    // Bytes that encode with +, / and = in standard base64, so a wrong encoding shows up.
    let credentialID = Data([0xfb, 0xff, 0xbf, 0x01, 0x02])
    let clientData = Data(#"{"type":"webauthn.get","challenge":"AAEC","origin":"https://edgecoder.io"}"#.utf8)
    let authData = Data([0xff, 0xfe, 0xfd, 0x00])
    let signature = Data([0x30, 0x45, 0xfb, 0xef])
    let userHandle = Data([0x3e, 0x3f])

    var portal: PasskeyPortalClient!

    override func setUp() {
        super.setUp()
        MockPortalProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockPortalProtocol.self]
        portal = PasskeyPortalClient(baseURL: URL(string: "https://edgecoder.io")!, session: URLSession(configuration: config))
    }

    private func assertion(userID: Data? = nil) -> PasskeyAssertion {
        PasskeyAssertion(credentialID: credentialID, clientDataJSON: clientData, authenticatorData: authData, signature: signature, userID: userID)
    }

    func testBase64URLRoundTripWithoutPadding() {
        XCTAssertEqual(credentialID.base64URLEncodedString(), "-_-_AQI")
        XCTAssertEqual(Data(base64URLEncoded: "-_-_AQI"), credentialID)
        XCTAssertEqual(Data(base64URLEncoded: "AAEC"), Data([0, 1, 2]))
        XCTAssertNil(Data(base64URLEncoded: "***"))
    }

    func testAssertionBodyIsWebAuthnJSONInBase64URL() throws {
        let body = PasskeyRequests.assertionBody(challengeId: "challenge-123456", assertion: assertion(userID: userHandle))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(json["challengeId"] as? String, "challenge-123456")
        XCTAssertEqual(json["credentialId"] as? String, "-_-_AQI")
        let credential = try XCTUnwrap(json["response"] as? [String: Any])
        XCTAssertEqual(credential["id"] as? String, "-_-_AQI")
        XCTAssertEqual(credential["rawId"] as? String, "-_-_AQI")
        XCTAssertEqual(credential["type"] as? String, "public-key")
        let response = try XCTUnwrap(credential["response"] as? [String: Any])
        XCTAssertEqual(response["clientDataJSON"] as? String, clientData.base64URLEncodedString())
        XCTAssertEqual(response["authenticatorData"] as? String, "__79AA")
        XCTAssertEqual(response["signature"] as? String, "MEX77w")
        XCTAssertEqual(response["userHandle"] as? String, "Pj8")
        for value in [credential["id"], response["clientDataJSON"], response["authenticatorData"], response["signature"]] {
            let s = try XCTUnwrap(value as? String)
            XCTAssertNil(s.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")), "not base64url: \(s)")
        }
    }

    func testAssertionBodyOmitsMissingUserHandle() throws {
        let body = PasskeyRequests.assertionBody(challengeId: "challenge-123456", assertion: assertion(userID: nil))
        let text = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        XCTAssertFalse(text.contains("userHandle"))
        let empty = PasskeyRequests.assertionBody(challengeId: "challenge-123456", assertion: assertion(userID: Data()))
        XCTAssertNil(empty.response.response.userHandle)
    }

    func testRegistrationBody() {
        let body = PasskeyRequests.registrationBody(
            challengeId: "challenge-123456",
            registration: PasskeyRegistration(credentialID: credentialID, clientDataJSON: clientData, attestationObject: Data([0xa3, 0xff]))
        )
        XCTAssertEqual(body.response.id, "-_-_AQI")
        XCTAssertEqual(body.response.rawId, "-_-_AQI")
        XCTAssertEqual(body.response.type, "public-key")
        XCTAssertEqual(body.response.response.attestationObject, "o_8")
    }

    func testOptionsParsing() throws {
        let json = #"{"challengeId":"c-1234567890","options":{"challenge":"AAEC","rpId":"edgecoder.io","timeout":60000,"userVerification":"preferred","allowCredentials":[{"id":"-_-_AQI","type":"public-key","transports":["internal","hybrid"]},{"id":"***"}]}}"#
        let options = try JSONDecoder().decode(PasskeyOptionsResponse.self, from: Data(json.utf8))
        let inputs = try PasskeyRequests.assertionInputs(options)
        XCTAssertEqual(inputs.challenge, Data([0, 1, 2]))
        XCTAssertEqual(inputs.allowedCredentialIDs, [credentialID])

        let bad = try JSONDecoder().decode(PasskeyOptionsResponse.self, from: Data(#"{"challengeId":"c-1234567890","options":{"challenge":""}}"#.utf8))
        XCTAssertThrowsError(try PasskeyRequests.assertionInputs(bad)) { XCTAssertEqual($0 as? PasskeyError, .invalidChallenge) }

        let noUser = try JSONDecoder().decode(PasskeyOptionsResponse.self, from: Data(#"{"challengeId":"c-1234567890","options":{"challenge":"AAEC"}}"#.utf8))
        XCTAssertThrowsError(try PasskeyRequests.registrationInputs(noUser)) { XCTAssertEqual($0 as? PasskeyError, .invalidUserId) }
    }

    func testServerErrorsBecomeWords() {
        XCTAssertEqual(PasskeyPortalClient.serverErrorCode(from: Data(#"{"error":"passkey_credential_not_found"}"#.utf8)), "passkey_credential_not_found")
        XCTAssertEqual(PasskeyPortalClient.serverErrorCode(from: Data(#"{"error":"x","retryAfterMs":5}"#.utf8)), "x")
        XCTAssertEqual(PasskeyPortalClient.serverErrorCode(from: Data("<html>".utf8)), "")
        XCTAssertEqual(
            PasskeyError.server(code: "passkey_credential_not_found", status: 404).errorDescription,
            "This passkey isn't registered to an EdgeCoder account. Sign in with email, then add a passkey on edgecoder.io in Settings → Profile."
        )
        XCTAssertEqual(PasskeyError.server(code: "", status: 502).errorDescription, "Passkey request failed (HTTP 502).")
        XCTAssertEqual(PasskeyError.server(code: "weird", status: 400).errorDescription, "Passkey request failed: weird (HTTP 400).")
    }

    func testSystemErrorsBecomeWords() {
        let cancel = NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.canceled.rawValue)
        XCTAssertEqual(PasskeyMessages.error(forSystemError: cancel), .cancelled)
        let failed = NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.failed.rawValue)
        XCTAssertNotNil(PasskeyMessages.error(forSystemError: failed).errorDescription)
        let other = NSError(domain: "x", code: 7, userInfo: [NSLocalizedDescriptionKey: "boom"])
        XCTAssertEqual(PasskeyMessages.error(forSystemError: other).errorDescription, "boom")
    }

    // MARK: - The whole sign-in against a mocked portal

    func testSignInFlowPostsTheAssertionToTheProductionPortal() async throws {
        MockPortalProtocol.answers = [
            "/auth/passkey/login/options": .init(status: 200, body: #"{"challengeId":"chal-1234567890","options":{"challenge":"AAEC","allowCredentials":[{"id":"-_-_AQI"}]}}"#),
            "/auth/passkey/login/verify": .init(status: 200, body: #"{"ok":true,"user":{"userId":"u1","email":"cody@edgecoder.io","emailVerified":true}}"#),
        ]
        var seenChallenge: Data?
        var seenAllowed: [Data] = []
        let flow = PasskeySignInFlow(portal: portal) { challenge, allowed in
            seenChallenge = challenge
            seenAllowed = allowed
            return self.assertion(userID: self.userHandle)
        }
        try await flow.run(email: "  cody@edgecoder.io ")

        XCTAssertEqual(seenChallenge, Data([0, 1, 2]))
        XCTAssertEqual(seenAllowed, [credentialID])
        XCTAssertEqual(MockPortalProtocol.requests.map(\.path), ["/auth/passkey/login/options", "/auth/passkey/login/verify"])
        let optionsBody = try JSONSerialization.jsonObject(with: MockPortalProtocol.requests[0].body) as? [String: String]
        XCTAssertEqual(optionsBody, ["email": "cody@edgecoder.io"])
        let verify = try JSONDecoder().decode(PasskeyRequests.AssertionBody.self, from: MockPortalProtocol.requests[1].body)
        XCTAssertEqual(verify.challengeId, "chal-1234567890")
        XCTAssertEqual(verify.credentialId, "-_-_AQI")
        XCTAssertEqual(verify.response.response.signature, "MEX77w")
    }

    func testSignInWithoutEmailSendsEmptyOptionsBody() async throws {
        MockPortalProtocol.answers = [
            "/auth/passkey/login/options": .init(status: 200, body: #"{"challengeId":"chal-1234567890","options":{"challenge":"AAEC"}}"#),
            "/auth/passkey/login/verify": .init(status: 200, body: #"{"ok":true}"#),
        ]
        let flow = PasskeySignInFlow(portal: portal) { _, allowed in
            XCTAssertEqual(allowed, [])
            return self.assertion()
        }
        try await flow.run(email: nil)
        let optionsBody = try JSONSerialization.jsonObject(with: MockPortalProtocol.requests[0].body) as? [String: String]
        XCTAssertEqual(optionsBody, [:])
    }

    func testSignInSurfacesAnUnknownCredential() async {
        MockPortalProtocol.answers = [
            "/auth/passkey/login/options": .init(status: 200, body: #"{"challengeId":"chal-1234567890","options":{"challenge":"AAEC"}}"#),
            "/auth/passkey/login/verify": .init(status: 404, body: #"{"error":"passkey_credential_not_found"}"#),
        ]
        let flow = PasskeySignInFlow(portal: portal) { _, _ in self.assertion() }
        do {
            try await flow.run(email: nil)
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? PasskeyError, .server(code: "passkey_credential_not_found", status: 404))
        }
    }

    func testSignInStopsWhenTheOptionsAreRefusedOrTheSheetIsCancelled() async {
        MockPortalProtocol.answers = [
            "/auth/passkey/login/options": .init(status: 404, body: #"{"error":"passkey_not_registered"}"#),
        ]
        var sheetShown = false
        let refused = PasskeySignInFlow(portal: portal) { _, _ in sheetShown = true; return self.assertion() }
        do { try await refused.run(email: "cody@edgecoder.io"); XCTFail("expected an error") } catch {
            XCTAssertEqual(error as? PasskeyError, .server(code: "passkey_not_registered", status: 404))
        }
        XCTAssertFalse(sheetShown)

        MockPortalProtocol.reset()
        MockPortalProtocol.answers = [
            "/auth/passkey/login/options": .init(status: 200, body: #"{"challengeId":"chal-1234567890","options":{"challenge":"AAEC"}}"#),
        ]
        let cancelled = PasskeySignInFlow(portal: portal) { _, _ in throw PasskeyError.cancelled }
        do { try await cancelled.run(email: nil); XCTFail("expected an error") } catch {
            XCTAssertEqual(error as? PasskeyError, .cancelled)
        }
        XCTAssertEqual(MockPortalProtocol.requests.map(\.path), ["/auth/passkey/login/options"])
    }

    func testEnrollFlow() async throws {
        MockPortalProtocol.answers = [
            "/auth/passkey/register/options": .init(status: 200, body: #"{"challengeId":"chal-1234567890","options":{"challenge":"AAEC","user":{"id":"Pj8","name":"cody@edgecoder.io"}}}"#),
            "/auth/passkey/register/verify": .init(status: 200, body: #"{"ok":true}"#),
        ]
        let flow = PasskeyEnrollFlow(portal: portal) { challenge, userID, name in
            XCTAssertEqual(challenge, Data([0, 1, 2]))
            XCTAssertEqual(userID, self.userHandle)
            XCTAssertEqual(name, "cody@edgecoder.io")
            return PasskeyRegistration(credentialID: self.credentialID, clientDataJSON: self.clientData, attestationObject: Data([1]))
        }
        try await flow.run()
        XCTAssertEqual(MockPortalProtocol.requests.map(\.path), ["/auth/passkey/register/options", "/auth/passkey/register/verify"])
    }

    func testProductionPortalAndRelyingParty() {
        XCTAssertEqual(AppConfig.production.portalBaseURL.absoluteString, "https://edgecoder.io")
        XCTAssertEqual(AppConfig.production.relyingPartyId, "edgecoder.io")
    }
}
