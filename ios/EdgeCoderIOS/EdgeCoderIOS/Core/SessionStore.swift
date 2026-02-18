import Foundation

@MainActor
final class SessionStore: ObservableObject {
    @Published var user: PortalUser?
    @Published var loading = false
    @Published var lastError: String?

    var isAuthenticated: Bool {
        user != nil
    }

    func refreshSession() async {
        loading = true
        defer { loading = false }
        do {
            struct MePayload: Codable {
                let user: PortalUser
            }
            let me: MePayload = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/me",
                method: "GET"
            )
            user = me.user
            lastError = nil
        } catch is CancellationError {
            // Ignore task cancellations to preserve current auth state.
            return
        } catch {
            user = nil
            lastError = error.localizedDescription
        }
    }

    func clear() {
        user = nil
    }
}
