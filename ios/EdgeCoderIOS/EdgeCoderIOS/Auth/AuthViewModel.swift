import Foundation
import SwiftUI
import AuthenticationServices
import CryptoKit
import Security
import UIKit
import ObjectiveC

enum SSOProvider: String {
    case google
    case microsoft
}

@MainActor
final class AuthViewModel: ObservableObject {
    @Published var email = ""
    @Published var password = ""
    @Published var displayName = ""
    /// Required to create an account: "I agree to the Terms, Privacy Policy and Acceptable Use Policy" (docs/legal/).
    @Published var acceptedTerms = false
    @Published var statusMessage = ""
    @Published var isLoading = false
    @Published var latestSeedPhrase: String?
    @Published var latestGuidanceSteps: [String] = []
    @Published var authCapabilities: AuthCapabilitiesPayload?
    private var webAuthSession: ASWebAuthenticationSession?
    private let callbackScheme = "edgecoder"

    private func displayMessage(for error: Error) -> String {
        if let passkey = error as? PasskeyError {
            return passkey.errorDescription ?? "Passkey request failed."
        }
        let raw = error.localizedDescription
        if raw.contains("passkey_not_registered") { return "No passkey is enrolled for this email yet." }
        if raw.contains("user_not_found") { return "No account found for that email." }
        if raw.contains("expected string, received undefined") && raw.contains("\"email\"") {
            return "Passkey login currently needs an email on the deployed server. Enter email first, or deploy the latest backend update."
        }
        if raw.contains("passkey_registration_failed") { return "Passkey enrollment failed. Check associated domains and RP ID." }
        if raw.contains("passkey_login_failed") { return "Passkey login failed. Try enrolling a new passkey." }
        if raw.contains("oauth_mobile_token_invalid") { return "SSO completed but mobile token exchange failed. Try again." }
        if raw.contains("WebAuthenticationSession error 1") || raw.contains("canceledLogin") {
            return "SSO flow closed before app callback completed. If browser sign-in succeeded, refresh Dashboard and try again."
        }
        return raw
    }

    private let api = APIClient.shared

    func signUp(sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        guard acceptedTerms else {
            statusMessage = "To create an account, agree to the Terms, Privacy Policy and Acceptable Use Policy."
            return
        }
        struct SignupBody: Encodable {
            let email: String
            let password: String
            let displayName: String?
            let acceptTerms: Bool
        }
        do {
            let response: SignupResponse = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/signup",
                method: "POST",
                body: SignupBody(
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password,
                    displayName: displayName.isEmpty ? nil : displayName,
                    acceptTerms: true
                )
            )
            latestSeedPhrase = response.walletOnboarding?.seedPhrase
            latestGuidanceSteps = response.walletOnboarding?.guidance?.steps ?? []
            if latestSeedPhrase != nil {
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 90_000_000_000)
                    await MainActor.run {
                        self?.latestSeedPhrase = nil
                    }
                }
            }
            statusMessage = "Signup successful. Verify email, then log in."
            await sessionStore.refreshSession()
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func login(sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        struct LoginBody: Encodable {
            let email: String
            let password: String
        }
        do {
            _ = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/login",
                method: "POST",
                body: LoginBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            ) as AuthResponse
            await sessionStore.refreshSession()
            statusMessage = sessionStore.isAuthenticated
                ? "Login successful."
                : "Login response received, but session was not established. Try again."
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func logout(sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        do {
            _ = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/logout",
                method: "POST",
                body: ["ok": true]
            ) as EmptyResponse
            sessionStore.clear()
            statusMessage = "Logged out."
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func resendVerification() async {
        isLoading = true
        defer { isLoading = false }
        struct ResendBody: Encodable { let email: String }
        do {
            _ = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/resend-verification",
                method: "POST",
                body: ResendBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines))
            ) as EmptyResponse
            statusMessage = "If the account exists, verification email was sent."
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func enrollPasskey() async {
        isLoading = true
        defer { isLoading = false }
        statusMessage = ""
        do {
            try await PasskeyManager.shared.enroll()
            statusMessage = "Passkey enrolled."
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func loginWithPasskey(sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        statusMessage = ""
        do {
            let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
            let knownEmail = sessionStore.user?.email.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let effectiveEmail = trimmedEmail.isEmpty ? knownEmail : trimmedEmail
            try await PasskeyManager.shared.signIn(email: effectiveEmail.isEmpty ? nil : effectiveEmail)
            await sessionStore.refreshSession()
            statusMessage = sessionStore.isAuthenticated
                ? "Logged in with passkey."
                : "Passkey accepted, but app session was not established. Try again."
        } catch {
            PasskeyLog.logger.error("passkey sign-in failed: \(String(describing: error), privacy: .public)")
            statusMessage = displayMessage(for: error)
        }
        if statusMessage.isEmpty {
            statusMessage = "Passkey sign-in did not complete. Try again."
        }
    }

    func refreshAuthCapabilities() async {
        do {
            let payload: AuthCapabilitiesPayload = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/capabilities",
                method: "GET"
            )
            authCapabilities = payload
        } catch {
            authCapabilities = nil
        }
    }

    func loginWithSSO(provider: SSOProvider, sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let callbackURL = "\(callbackScheme)://oauth-callback"
            guard var startURL = URL(string: "\(api.config.portalBaseURL.absoluteString)/auth/oauth/\(provider.rawValue)/start") else {
                throw APIClientError.invalidURL
            }
            // Bind the one-time mobile token to this sign-in: the portal stores sha256(verifier) and
            // only redeems the token together with the verifier, which never leaves this app.
            let verifier = try Self.makeOAuthVerifier()
            startURL.append(queryItems: [
                URLQueryItem(name: "appRedirect", value: callbackURL),
                URLQueryItem(name: "appChallenge", value: Self.oauthChallenge(for: verifier)),
            ])

            let redirected = try await runWebAuthSession(startURL: startURL, callbackScheme: callbackScheme)
            guard
                let components = URLComponents(url: redirected, resolvingAgainstBaseURL: false),
                components.host == "oauth-callback"
            else {
                throw APIClientError.serverError("Invalid OAuth callback.")
            }
            let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            if values["status"] != "ok" {
                throw APIClientError.serverError("OAuth flow did not complete.")
            }
            guard let token = values["mobile_token"], !token.isEmpty else {
                throw APIClientError.serverError("OAuth token missing from callback.")
            }

            struct CompleteBody: Encodable { let token: String; let verifier: String }
            _ = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/oauth/mobile/complete",
                method: "POST",
                body: CompleteBody(token: token, verifier: verifier)
            ) as AuthResponse

            await sessionStore.refreshSession()
            statusMessage = sessionStore.isAuthenticated
                ? "SSO login successful."
                : "SSO completed, but app session was not established."
        } catch {
            await sessionStore.refreshSession()
            if sessionStore.isAuthenticated {
                statusMessage = "SSO completed in browser and app session is now active."
            } else {
                statusMessage = displayMessage(for: error)
            }
        }
    }

    /// RFC 7636 verifier: 32 random bytes, base64url without padding (43 characters).
    static func makeOAuthVerifier() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw APIClientError.serverError("Could not start sign-in.")
        }
        return base64URL(Data(bytes))
    }

    /// base64url(sha256(verifier)), the `appChallenge` the portal binds the mobile token to.
    static func oauthChallenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func runWebAuthSession(startURL: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let presentationProvider = OAuthPresentationContextProvider()
            let session = ASWebAuthenticationSession(url: startURL, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.webAuthSession = nil
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL else {
                    continuation.resume(throwing: APIClientError.serverError("OAuth callback missing."))
                    return
                }
                continuation.resume(returning: callbackURL)
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = presentationProvider
            self.webAuthSession = session
            // Keep presentation provider alive while session is active.
            objc_setAssociatedObject(session, "presentationProvider", presentationProvider, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            session.start()
        }
    }
}

private final class OAuthPresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
