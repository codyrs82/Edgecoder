import AuthenticationServices
import Foundation
import UIKit

enum PasskeyError: LocalizedError {
    case invalidChallenge
    case invalidUserId
    case unsupportedCredential
    case missingAttestation

    var errorDescription: String? {
        switch self {
        case .invalidChallenge:
            return "Invalid passkey challenge."
        case .invalidUserId:
            return "Invalid passkey user id."
        case .unsupportedCredential:
            return "Unsupported passkey credential type."
        case .missingAttestation:
            return "Passkey attestation missing from device response."
        }
    }
}

@MainActor
final class PasskeyManager: NSObject {
    static let shared = PasskeyManager()

    private var continuation: CheckedContinuation<Void, Error>?
    private var completionPayload: ((Any) async throws -> Void)?

    private let api = APIClient.shared

    func performRegistration(options: PasskeyOptionsResponse) async throws {
        guard let user = options.options.user else {
            throw PasskeyError.invalidUserId
        }
        guard
            let challenge = Data(base64URLEncoded: options.options.challenge),
            let userId = Data(base64URLEncoded: user.id)
        else {
            throw PasskeyError.invalidChallenge
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: api.config.relyingPartyId
        )
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: user.name ?? "EdgeCoder User",
            userID: userId
        )

        completionPayload = { [weak self] authorization in
            guard let self else { return }
            guard let credential = authorization as? ASAuthorization,
                  let registration = credential.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
                throw PasskeyError.unsupportedCredential
            }
            guard let attestation = registration.rawAttestationObject,
                  !attestation.isEmpty else {
                throw PasskeyError.missingAttestation
            }

            let payload: [String: Any] = [
                "challengeId": options.challengeId,
                "response": [
                    "id": registration.credentialID.base64URLEncodedString(),
                    "rawId": registration.credentialID.base64URLEncodedString(),
                    "type": "public-key",
                    "response": [
                        "clientDataJSON": registration.rawClientDataJSON.base64URLEncodedString(),
                        "attestationObject": attestation.base64URLEncodedString(),
                        "transports": []
                    ]
                ]
            ]
            try await self.postJSON(path: "/auth/passkey/register/verify", payload: payload)
        }

        try await runAuthorization(request: request)
    }

    func performAssertion(options: PasskeyOptionsResponse) async throws {
        guard let challenge = Data(base64URLEncoded: options.options.challenge) else {
            throw PasskeyError.invalidChallenge
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: api.config.relyingPartyId
        )
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.allowedCredentials = (options.options.allowCredentials ?? []).compactMap {
            guard let id = Data(base64URLEncoded: $0.id) else { return nil }
            return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
        }

        completionPayload = { [weak self] authorization in
            guard let self else { return }
            guard let credential = authorization as? ASAuthorization,
                  let assertion = credential.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                throw PasskeyError.unsupportedCredential
            }

            let payload: [String: Any] = [
                "challengeId": options.challengeId,
                "credentialId": assertion.credentialID.base64URLEncodedString(),
                "response": [
                    "id": assertion.credentialID.base64URLEncodedString(),
                    "rawId": assertion.credentialID.base64URLEncodedString(),
                    "type": "public-key",
                    "response": [
                        "clientDataJSON": assertion.rawClientDataJSON.base64URLEncodedString(),
                        "authenticatorData": assertion.rawAuthenticatorData.base64URLEncodedString(),
                        "signature": assertion.signature.base64URLEncodedString(),
                        "userHandle": assertion.userID?.base64URLEncodedString()
                    ]
                ]
            ]
            try await self.postJSON(path: "/auth/passkey/login/verify", payload: payload)
        }

        try await runAuthorization(request: request)
    }

    private func runAuthorization(request: ASAuthorizationRequest) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func postJSON(path: String, payload: [String: Any]) async throws {
        let url = api.config.portalBaseURL.appending(path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        let session = URLSession(configuration: config)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            if let server = try? JSONDecoder().decode([String: String].self, from: data),
               let error = server["error"] {
                throw APIClientError.serverError(error)
            }
            throw APIClientError.serverError("Passkey verification failed.")
        }
    }
}

extension PasskeyManager: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        Task {
            do {
                try await completionPayload?(authorization)
                continuation?.resume()
            } catch {
                continuation?.resume(throwing: error)
            }
            continuation = nil
            completionPayload = nil
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
        completionPayload = nil
    }
}

private extension Data {
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
