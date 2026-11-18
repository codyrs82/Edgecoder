import Foundation
import StoreKit

/// How the iOS app lets people get more cSats (App Store Review Guidelines 3.1.1 / 3.1.3; see
/// docs/ios-app-store-release.md "Payments and the App Store"). cSats are spent inside the app
/// (chat, bots), so Apple treats them as digital goods: selling them in the app needs In-App
/// Purchase, and outside the US storefront even a button or link to buy them elsewhere is refused.
///
/// Set by the `EdgeCoderPurchaseMode` Info.plist key (build setting EDGECODER_PURCHASE_MODE):
/// - `none` (the default, and what TestFlight / App Store builds ship): no buying in the app and no
///   call to action. The wallet shows the balance, history and withdrawals; out-of-cSats replies
///   say so plainly.
/// - `link-out-us`: on the United States storefront only, "Buy cSats on edgecoder.io" opens the web
///   wallet in the browser (allowed there since the 2025 Epic v. Apple injunction). Every other
///   storefront behaves as `none`.
/// - `in-app-lightning`: the full Lightning invoice flow inside the app. For development and
///   internal testing only; App Review would reject it.
enum PurchaseMode: String {
    case none
    case linkOutUS = "link-out-us"
    case inAppLightning = "in-app-lightning"

    static var configured: PurchaseMode {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "EdgeCoderPurchaseMode") as? String)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        return PurchaseMode(rawValue: raw) ?? .none
    }
}

/// Whether the app shows host earnings: the Wallet's earnings, payouts and "Withdraw now", earning rows
/// in the activity list, and the on-device runtime's credits counter (Info.plist
/// `EdgeCoderHostEarningsInApp`, build setting `EDGECODER_HOST_EARNINGS_IN_APP` in project.yml). Off in
/// Release, so the App Store app is a coding app and not a financial one; on in Debug.
enum HostEarningsPolicy {
    static var inApp: Bool { enabled(raw: Bundle.main.object(forInfoDictionaryKey: "EdgeCoderHostEarningsInApp") as? String) }

    static func enabled(raw: String?) -> Bool {
        ["yes", "true", "1"].contains((raw ?? "").trimmingCharacters(in: .whitespaces).lowercased())
    }

    /// Ledger reasons that are host earnings or payouts (hidden from the activity list when earnings are off).
    static func isEarningsReason(_ reason: String) -> Bool {
        let base = String(reason.split(separator: ":").first ?? "")
        return ["compute_contribution", "payout", "payout_refund", "payout_fee_excess", "fee_pool_distribution"].contains(base)
    }
}

@MainActor
final class PurchasePolicy: ObservableObject {
    static let shared = PurchasePolicy()

    let mode: PurchaseMode
    /// The App Store storefront's country (ISO 3166-1 alpha-3, "USA"); nil until known.
    @Published private(set) var storefrontCountry: String?

    init(mode: PurchaseMode = .configured) {
        self.mode = mode
    }

    /// What the app may show for buying cSats right now.
    var effective: PurchaseMode { Self.effective(mode: mode, storefrontCountry: storefrontCountry) }

    nonisolated static func effective(mode: PurchaseMode, storefrontCountry: String?) -> PurchaseMode {
        switch mode {
        case .linkOutUS: return storefrontCountry == "USA" ? .linkOutUS : .none
        default: return mode
        }
    }

    var canBuyInApp: Bool { effective == .inAppLightning }
    var canLinkOut: Bool { effective == .linkOutUS }

    /// The web wallet (Settings > Wallet on edgecoder.io).
    var webBuyURL: URL { APIClient.shared.config.portalBaseURL.appending(path: ChatFailures.buyCSatsPath) }

    func refreshStorefront() async {
        guard mode == .linkOutUS else { return }
        storefrontCountry = await Storefront.current?.countryCode
    }
}
