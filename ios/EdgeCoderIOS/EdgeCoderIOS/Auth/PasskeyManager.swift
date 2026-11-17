import AuthenticationServices
import Foundation
import UIKit

/// Shows the system passkey sheet. The portal side (options, request bodies, verify) is in
/// PasskeyProtocol.swift. Every outcome resumes the continuation exactly once, so the caller always
/// gets a result or an error to show.
@MainActor
final class PasskeyManager: NSObject {
    static let shared = PasskeyManager()

    private enum Pending {
        case assertion(CheckedContinuation<PasskeyAssertion, Error>)
        case registration(CheckedContinuation<PasskeyRegistration, Error>)
    }

    private var pending: Pending?
    /// Held while the sheet is up: ASAuthorizationController does not keep itself alive, and a
    /// released controller never calls its delegate.
    private var controller: ASAuthorizationController?

    private let config = APIClient.shared.config

    func signIn(email: String?) async throws {
        let flow = PasskeySignInFlow(portal: .appDefault(config: config)) { [weak self] challenge, allowed in
            guard let self else { throw PasskeyError.noResponse }
            return try await self.requestAssertion(challenge: challenge, allowedCredentialIDs: allowed)
        }
        try await flow.run(email: email)
    }

    func enroll() async throws {
        let flow = PasskeyEnrollFlow(portal: .appDefault(config: config)) { [weak self] challenge, userID, name in
            guard let self else { throw PasskeyError.noResponse }
            return try await self.requestRegistration(challenge: challenge, userID: userID, name: name)
        }
        try await flow.run()
    }

    private func requestAssertion(challenge: Data, allowedCredentialIDs: [Data]) async throws -> PasskeyAssertion {
        guard pending == nil else { throw PasskeyError.alreadyInProgress }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: config.relyingPartyId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.allowedCredentials = allowedCredentialIDs.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        PasskeyLog.logger.debug("passkey sheet: assertion for rpId \(self.config.relyingPartyId, privacy: .public)")
        return try await withCheckedThrowingContinuation { continuation in
            pending = .assertion(continuation)
            present(request)
        }
    }

    private func requestRegistration(challenge: Data, userID: Data, name: String) async throws -> PasskeyRegistration {
        guard pending == nil else { throw PasskeyError.alreadyInProgress }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: config.relyingPartyId)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: userID)
        PasskeyLog.logger.debug("passkey sheet: registration for rpId \(self.config.relyingPartyId, privacy: .public)")
        return try await withCheckedThrowingContinuation { continuation in
            pending = .registration(continuation)
            present(request)
        }
    }

    private func present(_ request: ASAuthorizationRequest) {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        controller.performRequests()
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        let pending = self.pending
        self.pending = nil
        self.controller = nil
        guard let pending else {
            PasskeyLog.logger.error("passkey sheet: callback with nothing pending")
            return
        }
        switch pending {
        case .assertion(let continuation):
            continuation.resume(with: result.flatMap { authorization in
                guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                    return .failure(PasskeyError.unsupportedCredential)
                }
                return .success(PasskeyAssertion(
                    credentialID: credential.credentialID,
                    clientDataJSON: credential.rawClientDataJSON,
                    authenticatorData: credential.rawAuthenticatorData ?? Data(),
                    signature: credential.signature ?? Data(),
                    userID: credential.userID
                ))
            })
        case .registration(let continuation):
            continuation.resume(with: result.flatMap { authorization in
                guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
                    return .failure(PasskeyError.unsupportedCredential)
                }
                guard let attestation = credential.rawAttestationObject, !attestation.isEmpty else {
                    return .failure(PasskeyError.missingAttestation)
                }
                return .success(PasskeyRegistration(
                    credentialID: credential.credentialID,
                    clientDataJSON: credential.rawClientDataJSON,
                    attestationObject: attestation
                ))
            })
        }
    }
}

extension PasskeyManager: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
            return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            PasskeyLog.logger.debug("passkey sheet: completed")
            finish(.success(authorization))
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            let ns = error as NSError
            PasskeyLog.logger.error("passkey sheet: error \(ns.domain, privacy: .public) \(ns.code)")
            finish(.failure(PasskeyMessages.error(forSystemError: error)))
        }
    }
}
