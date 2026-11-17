import AuthenticationServices
import Foundation
import os

/// The portal side of passkey sign-in and enrollment, kept free of UI so it can be unit tested with a
/// mocked portal (EdgeCoderIOSTests/PasskeyProtocolTests.swift). PasskeyManager only adds the system
/// passkey sheet (ASAuthorizationController) on top.
///
/// Wire format: the portal (src/portal/routes/passkey.ts, @simplewebauthn/server) takes WebAuthn JSON,
/// every binary field base64url without padding:
///   POST /auth/passkey/login/options   {email?}                 -> {challengeId, options}
///   POST /auth/passkey/login/verify    {challengeId, credentialId, response:{id, rawId, type,
///                                       response:{clientDataJSON, authenticatorData, signature, userHandle?}}}
///   POST /auth/passkey/register/options {}                       -> {challengeId, options}
///   POST /auth/passkey/register/verify {challengeId, response:{id, rawId, type,
///                                       response:{clientDataJSON, attestationObject, transports}}}

enum PasskeyLog {
    /// Unobtrusive debug log: `log stream --predicate 'subsystem == "io.edgecoder.ios" AND category == "passkey"'`.
    /// Never logs challenges, signatures or cookies; credential ids only as a short prefix.
    static let logger = Logger(subsystem: "io.edgecoder.ios", category: "passkey")

    static func idPrefix(_ id: String) -> String { String(id.prefix(6)) + "…" }
}

enum PasskeyError: LocalizedError, Equatable {
    case invalidChallenge
    case invalidUserId
    case unsupportedCredential
    case missingAttestation
    case cancelled
    case alreadyInProgress
    case noResponse
    /// The system passkey sheet failed (ASAuthorizationError code, message).
    case system(code: Int, message: String)
    /// The portal refused (its `error` code, or a status line).
    case server(code: String, status: Int)

    var errorDescription: String? {
        switch self {
        case .invalidChallenge:
            return "The server sent an invalid passkey challenge. Try again."
        case .invalidUserId:
            return "The server sent an invalid passkey user id. Try again."
        case .unsupportedCredential:
            return "This device returned an unsupported passkey type."
        case .missingAttestation:
            return "This device did not return the passkey data needed to enroll it."
        case .cancelled:
            return "Passkey sign-in was cancelled."
        case .alreadyInProgress:
            return "A passkey request is already open. Finish or cancel it first."
        case .noResponse:
            return "The passkey sheet closed without an answer. Try again."
        case .system(_, let message):
            return message
        case .server(let code, let status):
            return PasskeyMessages.text(forServerError: code, status: status)
        }
    }
}

enum PasskeyMessages {
    /// What to show for a portal error code. Every passkey failure ends on screen with one of these.
    static func text(forServerError code: String, status: Int) -> String {
        switch code {
        case "passkey_credential_not_found":
            return "This passkey isn't registered to an EdgeCoder account. Sign in with email, then add a passkey on edgecoder.io in Settings → Profile."
        case "passkey_not_registered":
            return "No passkey is enrolled for this email yet. Sign in with email, then add a passkey on edgecoder.io in Settings → Profile."
        case "user_not_found":
            return "No account found for that email."
        case "passkey_challenge_invalid":
            return "The passkey request expired. Try again."
        case "passkey_account_mismatch":
            return "That passkey belongs to a different EdgeCoder account than the email entered."
        case "passkey_login_failed":
            return "The portal could not verify this passkey. Try again, or sign in with email and enroll a new passkey."
        case "passkey_registration_failed":
            return "Passkey enrollment failed. Try again."
        case "passkey_already_registered":
            return "This passkey is already registered."
        case "not_authenticated":
            return "Sign in first, then add a passkey."
        case "email_not_verified":
            return "Verify your email address first, then add a passkey."
        case "portal_database_not_configured":
            return "Sign-in is temporarily unavailable. Try again shortly."
        default:
            if code.isEmpty { return "Passkey request failed (HTTP \(status))." }
            return "Passkey request failed: \(code) (HTTP \(status))."
        }
    }

    /// ASAuthorizationController failures, in words. `canceled` is the user closing the sheet.
    static func error(forSystemError error: Error) -> PasskeyError {
        let ns = error as NSError
        guard ns.domain == ASAuthorizationError.errorDomain else {
            return .system(code: ns.code, message: ns.localizedDescription)
        }
        switch ASAuthorizationError.Code(rawValue: ns.code) {
        case .canceled:
            return .cancelled
        case .notInteractive:
            return .system(code: ns.code, message: "The passkey sheet could not be shown. Bring EdgeCoder to the front and try again.")
        case .invalidResponse, .notHandled:
            return .system(code: ns.code, message: "The passkey request was not handled. Try again.")
        case .failed:
            return .system(code: ns.code, message: "Passkeys are not available for edgecoder.io on this device (\(ns.localizedDescription)).")
        default:
            return .system(code: ns.code, message: "Passkey failed: \(ns.localizedDescription)")
        }
    }
}

extension Data {
    init?(base64URLEncoded string: String) {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: base64)
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// What the authenticator (the system passkey sheet) returned for a sign-in, as raw bytes.
struct PasskeyAssertion: Equatable {
    let credentialID: Data
    let clientDataJSON: Data
    let authenticatorData: Data
    let signature: Data
    let userID: Data?
}

/// What the authenticator returned for an enrollment.
struct PasskeyRegistration: Equatable {
    let credentialID: Data
    let clientDataJSON: Data
    let attestationObject: Data
}

/// Request bodies in the portal's WebAuthn JSON shape.
enum PasskeyRequests {
    struct AssertionBody: Codable, Equatable {
        struct Credential: Codable, Equatable {
            struct Response: Codable, Equatable {
                let clientDataJSON: String
                let authenticatorData: String
                let signature: String
                let userHandle: String?
            }
            let id: String
            let rawId: String
            let type: String
            let response: Response
        }
        let challengeId: String
        let credentialId: String
        let response: Credential
    }

    struct RegistrationBody: Codable, Equatable {
        struct Credential: Codable, Equatable {
            struct Response: Codable, Equatable {
                let clientDataJSON: String
                let attestationObject: String
                let transports: [String]
            }
            let id: String
            let rawId: String
            let type: String
            let response: Response
        }
        let challengeId: String
        let response: Credential
    }

    static func assertionBody(challengeId: String, assertion: PasskeyAssertion) -> AssertionBody {
        let id = assertion.credentialID.base64URLEncodedString()
        return AssertionBody(
            challengeId: challengeId,
            credentialId: id,
            response: .init(
                id: id,
                rawId: id,
                type: "public-key",
                response: .init(
                    clientDataJSON: assertion.clientDataJSON.base64URLEncodedString(),
                    authenticatorData: assertion.authenticatorData.base64URLEncodedString(),
                    signature: assertion.signature.base64URLEncodedString(),
                    userHandle: assertion.userID.flatMap { $0.isEmpty ? nil : $0.base64URLEncodedString() }
                )
            )
        )
    }

    static func registrationBody(challengeId: String, registration: PasskeyRegistration) -> RegistrationBody {
        let id = registration.credentialID.base64URLEncodedString()
        return RegistrationBody(
            challengeId: challengeId,
            response: .init(
                id: id,
                rawId: id,
                type: "public-key",
                response: .init(
                    clientDataJSON: registration.clientDataJSON.base64URLEncodedString(),
                    attestationObject: registration.attestationObject.base64URLEncodedString(),
                    transports: ["internal", "hybrid"]
                )
            )
        )
    }

    /// The decoded challenge and allowed credential ids from the portal's options.
    static func assertionInputs(_ options: PasskeyOptionsResponse) throws -> (challenge: Data, allowedCredentialIDs: [Data]) {
        guard !options.challengeId.isEmpty,
              let challenge = Data(base64URLEncoded: options.options.challenge), !challenge.isEmpty else {
            throw PasskeyError.invalidChallenge
        }
        let allowed = (options.options.allowCredentials ?? []).compactMap { Data(base64URLEncoded: $0.id) }
        return (challenge, allowed)
    }

    static func registrationInputs(_ options: PasskeyOptionsResponse) throws -> (challenge: Data, userID: Data, name: String) {
        guard !options.challengeId.isEmpty,
              let challenge = Data(base64URLEncoded: options.options.challenge), !challenge.isEmpty else {
            throw PasskeyError.invalidChallenge
        }
        guard let user = options.options.user, let userID = Data(base64URLEncoded: user.id), !userID.isEmpty else {
            throw PasskeyError.invalidUserId
        }
        return (challenge, userID, user.name ?? "EdgeCoder User")
    }
}

/// The portal calls of the passkey flows. `session` shares the app's cookie store, so the session
/// cookie set by login/verify is what APIClient sends afterwards.
struct PasskeyPortalClient {
    let baseURL: URL
    let session: URLSession

    static func appDefault(config: AppConfig = .current) -> PasskeyPortalClient {
        let sessionConfig = URLSessionConfiguration.default
        sessionConfig.httpCookieStorage = .shared
        sessionConfig.httpShouldSetCookies = true
        sessionConfig.httpCookieAcceptPolicy = .always
        sessionConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        sessionConfig.timeoutIntervalForRequest = 15
        sessionConfig.timeoutIntervalForResource = 30
        return PasskeyPortalClient(baseURL: config.portalBaseURL, session: URLSession(configuration: sessionConfig))
    }

    func loginOptions(email: String?) async throws -> PasskeyOptionsResponse {
        let trimmed = email?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body: [String: String] = trimmed.isEmpty ? [:] : ["email": trimmed]
        return try await decode(post("/auth/passkey/login/options", body: body))
    }

    func registrationOptions() async throws -> PasskeyOptionsResponse {
        try await decode(post("/auth/passkey/register/options", body: [String: String]()))
    }

    func verifyLogin(challengeId: String, assertion: PasskeyAssertion) async throws {
        _ = try await post("/auth/passkey/login/verify", body: PasskeyRequests.assertionBody(challengeId: challengeId, assertion: assertion))
    }

    func verifyRegistration(challengeId: String, registration: PasskeyRegistration) async throws {
        _ = try await post("/auth/passkey/register/verify", body: PasskeyRequests.registrationBody(challengeId: challengeId, registration: registration))
    }

    private func decode(_ data: Data) throws -> PasskeyOptionsResponse {
        do {
            return try JSONDecoder().decode(PasskeyOptionsResponse.self, from: data)
        } catch {
            PasskeyLog.logger.error("passkey options: undecodable response (\(data.count) bytes)")
            throw PasskeyError.invalidChallenge
        }
    }

    private func post<B: Encodable>(_ path: String, body: B) async throws -> Data {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        PasskeyLog.logger.debug("POST \(url.absoluteString, privacy: .public)")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        PasskeyLog.logger.debug("POST \(path, privacy: .public) -> \(http.statusCode)")
        guard (200...299).contains(http.statusCode) else {
            let code = Self.serverErrorCode(from: data)
            PasskeyLog.logger.error("POST \(path, privacy: .public) refused: \(http.statusCode) \(code, privacy: .public)")
            throw PasskeyError.server(code: code, status: http.statusCode)
        }
        return data
    }

    /// The portal's `{"error": "..."}` code; tolerant of extra non-string fields.
    static func serverErrorCode(from data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return (object["error"] as? String) ?? ""
    }
}

/// The whole sign-in: options from the portal, the authenticator, then verify. `authenticate` is the
/// system passkey sheet in the app and a fake in tests.
struct PasskeySignInFlow {
    let portal: PasskeyPortalClient
    let authenticate: (_ challenge: Data, _ allowedCredentialIDs: [Data]) async throws -> PasskeyAssertion

    func run(email: String?) async throws {
        let options = try await portal.loginOptions(email: email)
        let inputs = try PasskeyRequests.assertionInputs(options)
        PasskeyLog.logger.debug("passkey sign-in: options ok, \(inputs.allowedCredentialIDs.count) allowed credential(s)")
        let assertion = try await authenticate(inputs.challenge, inputs.allowedCredentialIDs)
        PasskeyLog.logger.debug("passkey sign-in: authenticator returned credential \(PasskeyLog.idPrefix(assertion.credentialID.base64URLEncodedString()), privacy: .public)")
        try await portal.verifyLogin(challengeId: options.challengeId, assertion: assertion)
        PasskeyLog.logger.debug("passkey sign-in: portal verified")
    }
}

struct PasskeyEnrollFlow {
    let portal: PasskeyPortalClient
    let register: (_ challenge: Data, _ userID: Data, _ name: String) async throws -> PasskeyRegistration

    func run() async throws {
        let options = try await portal.registrationOptions()
        let inputs = try PasskeyRequests.registrationInputs(options)
        let registration = try await register(inputs.challenge, inputs.userID, inputs.name)
        try await portal.verifyRegistration(challengeId: options.challengeId, registration: registration)
        PasskeyLog.logger.debug("passkey enroll: portal verified")
    }
}
