import SwiftUI

extension Notification.Name {
    /// A reply or purchase changed the cSats balance; the badge and wallet reload.
    static let edgeCoderBalanceChanged = Notification.Name("edgeCoderBalanceChanged")
}

/// The Bitcoin network and balance the signed-in account's coordinator reports
/// (/portal/api/wallet/overview `network`, `cSats`). Mainnet is real sats; anything else is test
/// sats, and the badge says so everywhere money shows.
@MainActor
final class NetworkStatusStore: ObservableObject {
    @Published private(set) var network: String?
    @Published private(set) var cSats: Double?

    struct Snapshot: Decodable {
        let network: String?
        let cSats: Double?
    }

    func refresh() async {
        guard let s: Snapshot = try? await APIClient.shared.request(baseURL: APIClient.shared.config.portalBaseURL, path: "/portal/api/wallet/overview") else { return }
        network = s.network
        cSats = s.cSats
    }

    func clear() {
        network = nil
        cSats = nil
    }
}

/// Mainnet is real money; every other network is test sats with no value.
struct NetworkInfo: Equatable {
    let label: String
    let short: String
    let isTest: Bool
    init(_ network: String?) {
        switch network {
        case "bitcoin", "mainnet": label = "Bitcoin mainnet · real sats"; short = "mainnet"; isTest = false
        case "regtest": label = "Regtest · test sats, no value"; short = "regtest"; isTest = true
        case "signet": label = "Signet · test sats, no value"; short = "signet"; isTest = true
        case "testnet", "testnet4": label = "Testnet · test sats, no value"; short = "testnet"; isTest = true
        default: label = "Network unknown"; short = network ?? "unknown"; isTest = true
        }
    }
}

/// The network badge (the portal's shared badge, #409): "mainnet" with the accent, a test network in yellow.
struct NetworkBadge: View {
    let network: String?
    var compact = false

    var body: some View {
        if let network {
            let info = NetworkInfo(network)
            HStack(spacing: 5) {
                Circle().fill(info.isTest ? Theme.yellow : Theme.accent).frame(width: 6, height: 6)
                Text(compact ? info.short : info.label).font(.caption2.weight(.semibold))
            }
            .foregroundColor(info.isTest ? Theme.yellow : Theme.textPrimary)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .overlay(Capsule().stroke(info.isTest ? Theme.yellow.opacity(0.5) : Theme.accent.opacity(0.7), lineWidth: 1))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(info.label)
        }
    }
}
