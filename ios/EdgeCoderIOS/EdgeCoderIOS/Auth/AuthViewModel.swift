import Foundation
import SwiftUI
import AuthenticationServices
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
    @Published var statusMessage = ""
    @Published var isLoading = false
    @Published var latestSeedPhrase: String?
    @Published var latestGuidanceSteps: [String] = []
    @Published var authCapabilities: AuthCapabilitiesPayload?
    private var webAuthSession: ASWebAuthenticationSession?
    private let callbackScheme = "edgecoder"

    private func displayMessage(for error: Error) -> String {
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
        struct SignupBody: Encodable {
            let email: String
            let password: String
            let displayName: String?
        }
        do {
            let response: SignupResponse = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/signup",
                method: "POST",
                body: SignupBody(
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password,
                    displayName: displayName.isEmpty ? nil : displayName
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
        do {
            let response: PasskeyOptionsResponse = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/passkey/register/options",
                method: "POST",
                body: [String: String]()
            )
            try await PasskeyManager.shared.performRegistration(options: response)
            statusMessage = "Passkey enrolled."
        } catch {
            statusMessage = displayMessage(for: error)
        }
    }

    func loginWithPasskey(sessionStore: SessionStore) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
            let knownEmail = sessionStore.user?.email.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let effectiveEmail = trimmedEmail.isEmpty ? knownEmail : trimmedEmail
            let body: [String: String] = effectiveEmail.isEmpty ? [:] : ["email": effectiveEmail]
            let response: PasskeyOptionsResponse = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/passkey/login/options",
                method: "POST",
                body: body
            )
            try await PasskeyManager.shared.performAssertion(options: response)
            await sessionStore.refreshSession()
            statusMessage = sessionStore.isAuthenticated
                ? "Logged in with passkey."
                : "Passkey accepted, but app session was not established. Try again."
        } catch {
            statusMessage = displayMessage(for: error)
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
            startURL.append(queryItems: [URLQueryItem(name: "appRedirect", value: callbackURL)])

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

            struct CompleteBody: Encodable { let token: String }
            _ = try await api.request(
                baseURL: api.config.portalBaseURL,
                path: "/auth/oauth/mobile/complete",
                method: "POST",
                body: CompleteBody(token: token)
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
