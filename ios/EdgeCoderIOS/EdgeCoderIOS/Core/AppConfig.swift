import Foundation

enum AppEnvironment: String, CaseIterable {
    case production
    case staging
}

struct AppConfig {
    let environment: AppEnvironment
    let portalBaseURL: URL
    let controlPlaneBaseURL: URL
    let coordinatorBootstrapURL: URL
    let relyingPartyId: String
    let passkeyOrigin: String

    static let production = AppConfig(
        environment: .production,
        portalBaseURL: URL(string: "https://edgecoder.io")!,
        controlPlaneBaseURL: URL(string: "https://control.edgecoder.io")!,
        coordinatorBootstrapURL: URL(string: "https://coordinator.edgecoder.io")!,
        relyingPartyId: "edgecoder.io",
        passkeyOrigin: "https://edgecoder.io"
    )

    static let staging = AppConfig(
        environment: .staging,
        portalBaseURL: URL(string: "https://edgecoder-portal.fly.dev")!,
        controlPlaneBaseURL: URL(string: "https://edgecoder-control-plane.fly.dev")!,
        coordinatorBootstrapURL: URL(string: "https://edgecoder-coordinator.fly.dev")!,
        relyingPartyId: "edgecoder-portal.fly.dev",
        passkeyOrigin: "https://edgecoder-portal.fly.dev"
    )

    static var current: AppConfig {
        let env = ProcessInfo.processInfo.environment["EDGECODER_IOS_ENV"]?.lowercased()
        if env == "staging" {
            return .staging
        }
        return .production
    }
}
