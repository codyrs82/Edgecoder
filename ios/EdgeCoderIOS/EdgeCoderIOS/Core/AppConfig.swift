import Foundation

enum AppEnvironment: String, CaseIterable {
    case production
    case staging
    case local
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

    static let local = AppConfig(
        environment: .local,
        portalBaseURL: URL(string: "http://localhost:4301")!,
        controlPlaneBaseURL: URL(string: "http://localhost:4301")!,
        coordinatorBootstrapURL: URL(string: "http://localhost:4301")!,
        relyingPartyId: "localhost",
        passkeyOrigin: "http://localhost:4301"
    )

    static var current: AppConfig {
        let env = ProcessInfo.processInfo.environment["EDGECODER_IOS_ENV"]?.lowercased()
        if env == "staging" {
            return .staging
        }
        if env == "local" {
            return .local
        }
        return .production
    }
}
