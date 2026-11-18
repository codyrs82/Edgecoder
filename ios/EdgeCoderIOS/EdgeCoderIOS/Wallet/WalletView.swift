import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

// Wallet & market (docs/design/wallet-and-market.md): balance, Add funds with a Lightning invoice
// (QR, copy, open in wallet, live waiting state, paid and expired states) or, when the coordinator
// has ONCHAIN_ENABLED, Fund with Bitcoin to a deposit address (QR, deposits with confirmations), where your sats go,
// prices now, earnings & withdrawals with payout methods and history. Everything comes from the
// portal over the session cookie; the app never prices anything except the purchase-fee preview
// before an invoice exists, which uses the coordinator's own rate and is replaced by the invoice.

enum WalletFormat {
    static func sats(_ n: Double) -> String { Int(n.rounded()).formatted(.number.grouping(.automatic)) }
    /// msat as sats with up to 3 decimals, so earnings below 1 sat are not shown as 0.
    static func msat(_ m: Double) -> String { (m / 1000).formatted(.number.precision(.fractionLength(0...3))) }
    static func num(_ n: Double, digits: Int = 2) -> String { n.formatted(.number.precision(.fractionLength(0...digits))) }
    static func pct(_ bps: Int) -> String { "\(num(Double(bps) / 100)) %" }
    static func usd(_ sats: Double, _ btcUsd: Double?) -> String? {
        guard let btcUsd, btcUsd > 0 else { return nil }
        let usd = sats / 1e8 * btcUsd
        if usd == 0 { return "≈ $0.00" }
        return "≈ $" + usd.formatted(.number.precision(.fractionLength(usd < 1 ? 3...4 : 2...2)))
    }
    /// floor(amount × bps / 10000), the coordinator's own formula (docs/economy-math.md section 2).
    static func preview(_ amount: Int, feeBps: Int) -> (fee: Int, get: Int) {
        let fee = amount * feeBps / 10_000
        return (fee, amount - fee)
    }
    static func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
    static func reason(_ r: String) -> String {
        if r.hasPrefix("credit_purchase:onchain:") { return "Bitcoin deposit" }
        let base = String(r.split(separator: ":").first ?? "")
        let map = [
            "credit_purchase": "Bought cSats", "inference_reserve": "Model call (set aside)", "inference": "Model call",
            "task_submit": "Code job (set aside)", "task_submit_refund": "Unused set-aside returned", "compute_reservation": "Reserved a machine",
            "reservation_refund": "Reservation time returned", "compute_contribution": "Earned running jobs", "payout": "Withdrawal",
            "payout_refund": "Withdrawal returned", "fee_pool_distribution": "Infrastructure host share",
        ]
        return map[base] ?? base.replacingOccurrences(of: "_", with: " ")
    }
}

/// A QR code for a Lightning invoice (or, with `scheme: "bitcoin"`, a Bitcoin deposit address), drawn
/// with CoreImage (a system framework; no package).
struct InvoiceQRCode: View {
    let text: String
    var scheme = "lightning"

    var body: some View {
        if let image = Self.render(text, scheme: scheme) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(10)
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityLabel(scheme == "bitcoin" ? "Bitcoin deposit address QR code" : "Lightning payment QR code")
        } else {
            Image(systemName: "qrcode").font(.largeTitle).foregroundColor(Theme.textMuted)
        }
    }

    static func render(_ text: String, scheme: String = "lightning") -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        // Upper case fits BOLT11 and bech32 addresses into the QR alphanumeric mode (a smaller, easier to scan code).
        filter.message = Data((scheme + ":" + text).uppercased().utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct WalletView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var purchasePolicy: PurchasePolicy

    @State private var overview: WalletOverview?
    @State private var destination: PayoutDestinationView?
    @State private var loading = true
    @State private var loadError = ""

    // Add funds
    private static let presets = [5_000, 20_000, 100_000]
    @State private var amount = 20_000
    @State private var customText = ""
    @State private var useCustom = false
    @State private var step: Step = .amount
    @State private var invoice: TopupInvoice?
    @State private var expiresAt = Date()
    @State private var paidCSats: Double = 0
    @State private var creating = false
    @State private var topupError = ""
    @State private var copied = false
    @State private var pollTask: Task<Void, Never>?
    @State private var pulse = false
    // Fund with Bitcoin
    @State private var onchain: OnchainFunding?
    @State private var onchainError = ""
    @State private var addressCopied = false
    @State private var onchainTask: Task<Void, Never>?

    // Withdraw
    @State private var bolt11 = ""
    @State private var withdrawCode = ""
    @State private var challengeId: String?
    @State private var challengeDetail = ""
    @State private var withdrawMessage: (ok: Bool, text: String)?
    @State private var withdrawing = false
    /// Two-factor step-up (#420): asked for when the portal answers two_factor_required.
    @State private var needsTwoFactor = false
    @State private var twoFactorCode = ""

    enum Step { case amount, onchain, invoice, paid, expired }

    private var portal: URL { APIClient.shared.config.portalBaseURL }
    private var network: NetworkInfo { NetworkInfo(overview?.network ?? invoice?.network) }
    /// Buying is free (0) unless the coordinator states a purchase fee.
    private var feeBps: Int { overview?.fees.purchaseFeeBps ?? 0 }
    private var netFeeBps: Int { overview?.fees.networkFeeBps ?? 500 }
    private var chosenAmount: Int { useCustom ? (Int(customText) ?? 0) : amount }
    /// The early-access caps and the global range (src/common/buy-limits.ts).
    private var buyLimit: BuyLimit {
        BuyLimits.limit(launch: overview?.launch, balanceCSats: overview?.cSats, feeBps: feeBps,
                        globalMin: overview?.topup.minSats ?? 100, globalMax: overview?.topup.maxSats ?? 1_000_000)
    }
    private var amountValid: Bool { BuyLimits.fits(chosenAmount, buyLimit) }
    private var onchainPolicy: WalletOverview.OnchainPolicy? {
        guard let p = overview?.payouts?.policy?.onchain, p.enabled else { return nil }
        return p
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                networkBadge
                if loading && overview == nil {
                    ProgressView("Loading wallet…").tint(Theme.textMuted).frame(maxWidth: .infinity).padding(.vertical, 40)
                } else {
                    if !loadError.isEmpty {
                        card { Text(loadError).font(.subheadline).foregroundColor(Theme.red) }
                    }
                    balanceCard
                    if purchasePolicy.canBuyInApp {
                        addFundsCard
                    } else if purchasePolicy.canLinkOut {
                        linkOutCard
                    }
                    feesCard
                    pricesCard
                    earningsSection
                    activityCard
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Theme.bgDeep)
        .navigationTitle("Wallet")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .onDisappear { pollTask?.cancel(); onchainTask?.cancel() }
    }

    // MARK: Sections

    private var networkBadge: some View {
        HStack(spacing: 6) {
            Circle().fill(network.isTest ? Theme.yellow : Theme.accent).frame(width: 7, height: 7)
            Text(overview == nil && invoice == nil ? "Checking network…" : network.label)
                .font(.caption.weight(.semibold))
        }
        .foregroundColor(network.isTest ? Theme.yellow : Theme.textPrimary)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .overlay(Capsule().stroke(network.isTest ? Theme.yellow.opacity(0.5) : Theme.accent, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var balanceCard: some View {
        card {
            Label("Balance", systemImage: "wallet.pass").font(.caption.weight(.semibold)).foregroundColor(Theme.textSecondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(overview?.cSats.map { WalletFormat.num($0) } ?? "–")
                    .font(.system(size: 40, weight: .semibold, design: .rounded)).monospacedDigit()
                    .foregroundColor(Theme.textPrimary).minimumScaleFactor(0.6).lineLimit(1)
                Text("cSats").font(.headline).foregroundColor(Theme.textSecondary)
            }
            .accessibilityElement(children: .combine)
            if let o = overview, let c = o.cSats, let usd = WalletFormat.usd(c, o.btcUsd), let btc = o.btcUsd {
                Text("\(usd) · BTC $\(WalletFormat.sats(btc))\(o.rateStale == true ? " (rate is stale)" : "")")
                    .font(.footnote).foregroundColor(Theme.textSecondary)
            } else if overview?.connected == false {
                Text("Not connected to the network right now. Your balance is safe.").font(.footnote).foregroundColor(Theme.textSecondary)
            }
            HStack(spacing: 10) {
                mini("Earned by your machines", overview?.payouts?.balance.map { "\(WalletFormat.msat($0.earnedMsat)) sats" } ?? overview?.earnedSats.map { "\(WalletFormat.sats($0)) sats" } ?? "–")
                mini("Available to withdraw", overview?.payouts?.balance.map { "\(WalletFormat.msat($0.payableMsat)) sats" } ?? "–")
            }
            Text("1 cSat = 1 sat. Spend it on model calls, code jobs and reserved machines.")
                .font(.footnote).foregroundColor(Theme.textMuted)
        }
        .background(
            RadialGradient(colors: [Theme.accent.opacity(0.14), .clear], center: .topLeading, startRadius: 0, endRadius: 260)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        )
    }

    @ViewBuilder private var addFundsCard: some View {
        card {
            switch step {
            case .amount: amountStep
            case .onchain: onchainStep
            case .invoice: invoiceStep
            case .paid: paidStep
            case .expired: expiredStep
            }
        }
    }

    private var amountStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Buy cSats").font(.headline).foregroundColor(Theme.textPrimary)
                pill("Lightning")
            }
            fundMethodPicker
            Text(onchainPolicy == nil
                 ? "Fund with Lightning from any wallet. Your cSats arrive the moment the payment lands. Fund with Bitcoin is coming soon."
                 : "Fund with Lightning from any wallet. Your cSats arrive the moment the payment lands.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(Self.presets, id: \.self) { p in
                    presetButton(title: WalletFormat.sats(Double(p)), subtitle: "sats", selected: !useCustom && amount == p) {
                        useCustom = false; amount = p
                    }
                    .disabled(!BuyLimits.fits(p, buyLimit))
                }
                presetButton(title: "Custom", subtitle: BuyLimits.rangeLabel(buyLimit), selected: useCustom) {
                    useCustom = true
                    if customText.isEmpty { customText = String(amount) }
                }
            }
            if useCustom {
                TextField("Amount in sats", text: $customText)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Amount in sats")
            }
            breakdown(
                pay: amountValid ? "\(WalletFormat.sats(Double(chosenAmount))) sats" : BuyLimits.rangeLabel(buyLimit) + " sats",
                payUsd: amountValid ? WalletFormat.usd(Double(chosenAmount), overview?.btcUsd) : nil,
                feeLabel: feeBps > 0 ? "Purchase fee (\(WalletFormat.pct(feeBps)))" : nil,
                fee: amountValid ? "− \(WalletFormat.sats(Double(WalletFormat.preview(chosenAmount, feeBps: feeBps).fee))) sats" : "–",
                getLabel: "You get",
                get: amountValid ? "\(WalletFormat.sats(Double(WalletFormat.preview(chosenAmount, feeBps: feeBps).get))) cSats" : "–"
            )
            if feeBps == 0 {
                Text("No purchase fee: 1 sat buys 1 cSat.").font(.footnote).foregroundColor(Theme.textSecondary)
            }
            Button {
                Task { await createInvoice() }
            } label: {
                Text(creating ? "Preparing payment…" : amountValid ? "Buy \(WalletFormat.sats(Double(chosenAmount))) cSats with Lightning" : "Enter \(BuyLimits.rangeLabel(buyLimit)) sats")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
            .disabled(!amountValid || creating)
            let limitText = BuyLimits.limitText(chosenAmount, buyLimit)
            if !limitText.isEmpty {
                Text(limitText).font(.footnote).foregroundColor(Theme.yellow)
            } else if let cap = buyLimit.dailyCapSats {
                Text("Early access: up to \(WalletFormat.sats(Double(cap))) sats per day (\(WalletFormat.sats(Double(buyLimit.dailyLeftSats ?? 0))) left today).")
                    .font(.footnote).foregroundColor(Theme.textSecondary)
            }
            if !topupError.isEmpty {
                Text(topupError).font(.footnote).foregroundColor(Theme.red)
            }
            if network.isTest && overview != nil {
                Label("This coordinator runs on \(network.short). Pay with a \(network.short) wallet; these sats have no value.", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundColor(Theme.yellow)
            }
        }
    }

    /// United States storefront only (PurchasePolicy .linkOutUS): buying happens on the web.
    private var linkOutCard: some View {
        card {
            Text("Buy cSats").font(.headline).foregroundColor(Theme.textPrimary)
            Text("Buy cSats with Lightning on edgecoder.io. They show up here as soon as the payment lands.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            Button {
                openURL(purchasePolicy.webBuyURL)
            } label: {
                Label("Buy cSats on edgecoder.io", systemImage: "arrow.up.forward.app")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
        }
    }

    private var fundMethodPicker: some View {
        HStack(spacing: 8) {
            Button { openLightning() } label: {
                Label("Fund with Lightning", systemImage: "bolt.fill").font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered).tint(step == .amount ? Theme.accent : Theme.textSecondary)
            .accessibilityAddTraits(step == .amount ? .isSelected : [])
            if onchainPolicy != nil {
                Button { Task { await openOnchain() } } label: {
                    Label("Fund with Bitcoin", systemImage: "bitcoinsign.circle").font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered).tint(step == .onchain ? Theme.accent : Theme.textSecondary)
                .accessibilityAddTraits(step == .onchain ? .isSelected : [])
            } else {
                Label("Fund with Bitcoin · Coming soon", systemImage: "bitcoinsign.circle").font(.caption.weight(.semibold))
                    .foregroundColor(Theme.textMuted)
                    .accessibilityLabel("Fund with Bitcoin, coming soon")
            }
        }
    }

    private var onchainStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Fund with Bitcoin").font(.headline).foregroundColor(Theme.textPrimary)
                pill(network.isTest ? "\(network.short) · test sats" : "On-chain · mainnet")
            }
            fundMethodPicker
            Text("Send bitcoin from any wallet to your deposit address. Your cSats arrive once the payment is confirmed on the blockchain.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            if !onchainError.isEmpty {
                Text(onchainError).font(.footnote).foregroundColor(Theme.red)
            }
            if let o = onchain, let address = o.address {
                InvoiceQRCode(text: address, scheme: "bitcoin")
                    .frame(maxWidth: 240).frame(maxWidth: .infinity)
                Text(address)
                    .font(.system(.footnote, design: .monospaced)).foregroundColor(Theme.textPrimary)
                    .textSelection(.enabled)
                    .accessibilityLabel("Your Bitcoin deposit address \(address)")
                HStack(spacing: 8) {
                    Button {
                        UIPasteboard.general.string = address
                        addressCopied = true
                        Task { try? await Task.sleep(nanoseconds: 1_600_000_000); addressCopied = false }
                    } label: {
                        Label(addressCopied ? "Copied" : "Copy address", systemImage: addressCopied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
                    Button {
                        if let url = URL(string: "bitcoin:\(address)") { openURL(url) }
                    } label: {
                        Label("Open in wallet", systemImage: "arrow.up.forward.app").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).tint(Theme.textPrimary)
                }
                let conf = o.confirmationsRequired ?? onchainPolicy?.depositConfirmations ?? 1
                Text("Credited after \(conf) confirmation\(conf == 1 ? "" : "s"). Minimum \(WalletFormat.sats(Double(o.minSats ?? onchainPolicy?.depositMinSats ?? 0))) sats; smaller amounts are not credited.\((o.maxSats ?? 0) > 0 ? " Deposits above \(WalletFormat.sats(Double(o.maxSats ?? 0))) sats wait for a manual review." : "") You get a new address after each deposit; old ones still work.")
                    .font(.caption).foregroundColor(Theme.textMuted)
            } else if onchainError.isEmpty {
                ProgressView("Getting your address…").tint(Theme.textMuted).frame(maxWidth: .infinity)
            }
            if network.isTest && overview != nil {
                Label("This coordinator runs on \(network.short). Send \(network.short) coins only; these sats have no value.", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundColor(Theme.yellow)
            }
            Text("Deposits").font(.subheadline.weight(.semibold)).foregroundColor(Theme.textPrimary)
            let deposits = onchain?.deposits ?? []
            if deposits.isEmpty {
                Text("No deposits yet. They show up here as soon as the network sees them.").font(.footnote).foregroundColor(Theme.textSecondary)
            }
            ForEach(deposits) { d in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(WalletFormat.sats(Double(d.amountSats))) sats").font(.subheadline).monospacedDigit().foregroundColor(Theme.textPrimary)
                        Text(WalletFormat.time(d.seenAtMs)).font(.caption).foregroundColor(Theme.textMuted)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Self.depositStatus(d.status)).font(.caption2.weight(.semibold))
                            .foregroundColor(d.status == "credited" ? Theme.green : d.status == "pending" || d.status == "held" ? Theme.yellow : Theme.red)
                        Text(d.status == "pending" ? "\(min(d.confirmations, d.requiredConfirmations)) of \(d.requiredConfirmations) confirmations" : "\(d.confirmations) confirmations")
                            .font(.caption).monospacedDigit().foregroundColor(Theme.textMuted)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    static func depositStatus(_ s: String) -> String {
        ["pending": "Confirming", "credited": "Added", "below_minimum": "Below minimum", "held": "Held for review", "dropped": "Dropped", "reversed": "Reversed"][s] ?? s
    }

    private func onchainPayoutText(_ p: WalletOverview.OnchainPolicy) -> String {
        let hours = (p.payoutIntervalMs ?? 0) / 3_600_000
        let every = hours >= 1 ? "every \(WalletFormat.num(hours, digits: 1)) h" : "every \(Int(((p.payoutIntervalMs ?? 0) / 60_000).rounded())) min"
        let fee = p.payoutFeePayer == "edgecoder"
            ? "EdgeCoder pays the network fee."
            : "The network fee comes out of your payout (at most \(WalletFormat.sats(Double(p.payoutMaxFeeSats ?? 0))) sats; the unused part is returned)."
        return "BTC to your own bc1 address. Paid in a batch \(every) once at least \(WalletFormat.sats(Double(p.payoutMinSats ?? 0))) sats are available. \(fee)"
    }

    @ViewBuilder private var invoiceStep: some View {
        if let invoice {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Scan to pay").font(.headline).foregroundColor(Theme.textPrimary)
                    pill(NetworkInfo(invoice.network).isTest ? "\(NetworkInfo(invoice.network).short) · test sats" : "Lightning · mainnet")
                }
                Text("Pay \(WalletFormat.sats(Double(invoice.amountSats))) sats\(WalletFormat.usd(Double(invoice.amountSats), overview?.btcUsd).map { " (\($0))" } ?? ""). You get \(WalletFormat.num(invoice.cSats, digits: 3)) cSats\(invoice.feeSats > 0 ? " after the \(WalletFormat.sats(Double(invoice.feeSats))) sat purchase fee." : "; there is no purchase fee.")")
                    .font(.footnote).foregroundColor(Theme.textSecondary)
                InvoiceQRCode(text: invoice.invoice)
                    .frame(maxWidth: 240).frame(maxWidth: .infinity)
                Text(invoice.invoice)
                    .font(.system(.caption2, design: .monospaced)).foregroundColor(Theme.textSecondary)
                    .lineLimit(3).truncationMode(.middle)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Button {
                        UIPasteboard.general.string = invoice.invoice
                        copied = true
                        Task { try? await Task.sleep(nanoseconds: 1_600_000_000); copied = false }
                    } label: {
                        Label(copied ? "Copied" : "Copy payment code", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
                    Button {
                        if let url = URL(string: "lightning:\(invoice.invoice)") { openURL(url) }
                    } label: {
                        Label("Open in wallet", systemImage: "arrow.up.forward.app").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).tint(Theme.textPrimary)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack(spacing: 10) {
                        Circle().fill(Theme.accent).frame(width: 10, height: 10)
                            .scaleEffect(pulse && !reduceMotion ? 1.35 : 1)
                            .opacity(pulse && !reduceMotion ? 0.55 : 1)
                            .animation(reduceMotion ? nil : .easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
                            .onAppear { pulse = true }
                            .accessibilityHidden(true)
                        Text("Waiting for payment…").font(.subheadline).foregroundColor(Theme.textPrimary)
                        Spacer()
                        Text(countdown(until: expiresAt, now: context.date)).font(.caption).monospacedDigit().foregroundColor(Theme.textMuted)
                    }
                    .padding(12)
                    .background(Theme.bgBase)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityElement(children: .combine)
                }
                Button("Choose another amount") { backToAmount() }
                    .font(.footnote).foregroundColor(Theme.textSecondary)
            }
        }
    }

    @ViewBuilder private var paidStep: some View {
        if let invoice {
            VStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 48)).foregroundColor(Theme.green)
                    .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
                Text("Payment received").font(.caption.weight(.semibold)).foregroundColor(Theme.textSecondary)
                Text("+\(WalletFormat.num(paidCSats, digits: 3)) cSats").font(.title.weight(.semibold)).monospacedDigit().foregroundColor(Theme.textPrimary)
                breakdown(
                    pay: "\(WalletFormat.sats(Double(invoice.amountSats))) sats", payUsd: nil,
                    feeLabel: invoice.feeSats > 0 ? "Purchase fee" : nil, fee: "− \(WalletFormat.sats(Double(invoice.feeSats))) sats",
                    getLabel: "Added to your balance", get: "\(WalletFormat.num(paidCSats, digits: 3)) cSats"
                )
                if let c = overview?.cSats {
                    row("New balance", "\(WalletFormat.num(c)) cSats")
                }
                Button { backToAmount() } label: { Text("Done").frame(maxWidth: .infinity).padding(.vertical, 10) }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
        }
    }

    private var expiredStep: some View {
        VStack(spacing: 10) {
            Image(systemName: "clock.badge.exclamationmark").font(.system(size: 44)).foregroundColor(Theme.yellow)
            Text("This payment code expired").font(.title3.weight(.semibold)).foregroundColor(Theme.textPrimary)
            Text("Nothing was charged. Get a new code to try again.").font(.footnote).foregroundColor(Theme.textSecondary)
            Button { Task { step = .amount; await createInvoice() } } label: { Text("New payment code").frame(maxWidth: .infinity).padding(.vertical, 10) }
                .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
            Button("Change amount") { backToAmount() }.font(.footnote).foregroundColor(Theme.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var feesCard: some View {
        card {
            Text("Where your sats go").font(.headline).foregroundColor(Theme.textPrimary)
            Text("Adding funds is \(feeBps > 0 ? "\(WalletFormat.pct(feeBps)) on this coordinator" : "free"). When you use compute on someone else's machine, \(WalletFormat.pct(10_000 - netFeeBps)) goes to that machine's owner and EdgeCoder keeps \(WalletFormat.pct(netFeeBps)). Nothing else is taken.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            row("Buying cSats", feeBps > 0 ? "\(WalletFormat.pct(feeBps)) purchase fee" : "Free · 1 sat = 1 cSat")
            Text("When you spend cSats on someone else's machine").font(.footnote).foregroundColor(Theme.textSecondary)
            GeometryReader { geo in
                HStack(spacing: 0) {
                    Rectangle().fill(Theme.green).frame(width: geo.size.width * Double(10_000 - netFeeBps) / 10_000)
                    Rectangle().fill(Theme.accent)
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())
            .accessibilityLabel("\(WalletFormat.pct(10_000 - netFeeBps)) to the machine's owner, \(WalletFormat.pct(netFeeBps)) kept by EdgeCoder")
            legend(Theme.green, "\(WalletFormat.pct(10_000 - netFeeBps)) to the machine's owner (the compute host)")
            legend(Theme.accent, "\(WalletFormat.pct(netFeeBps)) kept by EdgeCoder (the network fee)")
            Text("Work on your own machines costs nothing. Failed work is not charged.").font(.footnote).foregroundColor(Theme.textMuted)
        }
    }

    private var pricesCard: some View {
        card {
            Text("Prices now").font(.headline).foregroundColor(Theme.textPrimary)
            let classes = (overview?.classes ?? [:]).sorted { ($0.value.cSatsPerSecondBaseTier ?? 0) < ($1.value.cSatsPerSecondBaseTier ?? 0) }
            if classes.isEmpty {
                Text("Prices appear when a coordinator is reachable.").font(.footnote).foregroundColor(Theme.textSecondary)
            } else {
                ForEach(classes, id: \.key) { id, c in
                    let perS = c.cSatsPerSecondBaseTier ?? 0
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.label ?? id).font(.subheadline.weight(.medium)).foregroundColor(Theme.textPrimary)
                            Text("\(WalletFormat.num(perS * 3600, digits: perS * 3600 < 10 ? 2 : 0)) sats/h\(WalletFormat.usd(perS * 3600, overview?.btcUsd).map { " · \($0)/h" } ?? "")")
                                .font(.caption).foregroundColor(Theme.textSecondary)
                        }
                        Spacer()
                        Text("\(WalletFormat.num(perS, digits: 4)) cSats/s").font(.subheadline).monospacedDigit().foregroundColor(Theme.textPrimary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if let models = overview?.models, !models.isEmpty {
                Divider().overlay(Theme.border)
                Text("Model calls, cSats per million tokens (in / out)").font(.footnote).foregroundColor(Theme.textSecondary)
                ForEach(models) { m in
                    HStack {
                        Text(m.model).font(.footnote).foregroundColor(Theme.textPrimary).lineLimit(1)
                        Spacer()
                        Text(m.cSatsPerMTokens.map { "\(WalletFormat.num($0.input)) / \(WalletFormat.num($0.output))" } ?? "–")
                            .font(.footnote).monospacedDigit().foregroundColor(Theme.textPrimary)
                    }
                }
            }
            Text("Per second on each class's base tier. A machine's price comes from the order book and stays between 0.25x and 4x of the class reference.")
                .font(.caption).foregroundColor(Theme.textMuted)
        }
    }

    @ViewBuilder private var earningsSection: some View {
        let b = overview?.payouts?.balance
        let policy = overview?.payouts?.policy
        Text("Earnings & withdrawals").font(.title3.weight(.semibold)).foregroundColor(Theme.textPrimary).padding(.top, 6)
        Text("What your machines earned: \(WalletFormat.pct(10_000 - netFeeBps)) of what their work was paid (EdgeCoder keeps \(WalletFormat.pct(netFeeBps))). Purchased cSats can be spent but not withdrawn.")
            .font(.footnote).foregroundColor(Theme.textSecondary)
        if policy?.paused == true {
            Label("Withdrawals are paused on this coordinator while it is checked. Your earnings are safe; buying cSats still works.", systemImage: "exclamationmark.triangle.fill")
                .font(.footnote).foregroundColor(Theme.textPrimary)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.6)))
        }
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            kpi("Earned", b.map { "\(WalletFormat.msat($0.earnedMsat)) sats" } ?? "–", "All time", Theme.textPrimary)
            kpi("Held", b.map { "\(WalletFormat.msat($0.heldMsat)) sats" } ?? "–",
                b.flatMap { $0.heldMsat > 0 ? $0.maturesAtMs : nil }.map { "Available \(WalletFormat.time($0))" } ?? (policy?.network == "bitcoin" ? "Earnings wait 24 h" : "No hold on this network"), Theme.yellow)
            kpi("Available", b.map { "\(WalletFormat.msat($0.payableMsat)) sats" } ?? "–", "Ready to withdraw", Theme.green)
            kpi("Paid out", b.map { "\(WalletFormat.msat($0.paidMsat)) sats" } ?? "–", (b?.pendingMsat ?? 0) > 0 ? "\(WalletFormat.msat(b!.pendingMsat)) sats on the way" : " ", Theme.textPrimary)
        }
        Text("Payout method").font(.footnote).foregroundColor(Theme.textSecondary)
        method("bolt.fill", "Lightning", WithdrawPolicy.inApp
               ? "BTC. Withdraw now from any Lightning wallet, or get paid automatically to a Lightning address."
               : "BTC. Get paid automatically to a Lightning address, or withdraw from the EdgeCoder desktop app.", active: true)
        if let oc = onchainPolicy {
            method("bitcoinsign.circle", "Bitcoin on-chain", onchainPayoutText(oc), active: true, badge: "Available")
        } else {
            method("bitcoinsign.circle", "Bitcoin on-chain", "BTC. Batched payouts above a minimum. Not available yet.", active: false)
        }
        method("z.circle", "Zcash on-chain", "ZEC. Batched payouts. Not available yet.", active: false)
        if WithdrawPolicy.inApp {
            withdrawCard(policy: policy)
        } else {
            Text("Withdrawals are made in the EdgeCoder desktop app.").font(.footnote).foregroundColor(Theme.textSecondary)
                .accessibilityIdentifier("walletWithdrawElsewhere")
        }
        card {
            Text("Where we pay you").font(.headline).foregroundColor(Theme.textPrimary)
            row(destination?.destination?.kind == "onchain" ? "Bitcoin address" : "Lightning address", destination?.destination?.destination ?? "Not set")
            Text(onchainPolicy == nil
                 ? "Automatic payouts go to a Lightning address from a wallet you control. Set or change it in the portal or the desktop app."
                 : "Automatic payouts go to a Lightning address or a Bitcoin address (bc1…) from a wallet you control. Set or change it in the portal or the desktop app.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            if destination?.destination?.kind == "onchain", let oc = onchainPolicy {
                Text(onchainPayoutText(oc)).font(.caption).foregroundColor(Theme.textMuted)
            }
        }
        card {
            Text("Payout history").font(.headline).foregroundColor(Theme.textPrimary)
            let rows = overview?.payouts?.payouts ?? []
            if rows.isEmpty {
                Text("No payouts yet. Earnings you withdraw show up here.").font(.footnote).foregroundColor(Theme.textSecondary)
            }
            ForEach(rows) { p in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.kind == "onchain"
                             ? "On-chain batch · BTC\(p.txid.map { " · \($0.prefix(10))…" } ?? "")"
                             : "\(p.kind == "auto" ? "Automatic" : "Withdrawal") · BTC · Lightning").font(.subheadline).foregroundColor(Theme.textPrimary)
                        Text(WalletFormat.time(p.createdAtMs)).font(.caption).foregroundColor(Theme.textMuted)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(WalletFormat.msat(p.amountMsat)) sats").font(.subheadline).monospacedDigit().foregroundColor(Theme.textPrimary)
                        Text(p.status.uppercased()).font(.caption2.weight(.semibold))
                            .foregroundColor(p.status == "paid" ? Theme.green : p.status == "failed" ? Theme.red : Theme.yellow)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func withdrawCard(policy: WalletOverview.PayoutPolicy?) -> some View {
        card {
            Text("Withdraw now").font(.headline).foregroundColor(Theme.textPrimary)
            Text("In your Lightning wallet, choose Receive for the exact amount, paste its payment code here, and confirm with the code we email you.")
                .font(.footnote).foregroundColor(Theme.textSecondary)
            TextField("lnbc…", text: $bolt11, axis: .vertical)
                .lineLimit(2...4)
                .font(.system(.footnote, design: .monospaced))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Lightning payment code")
            if needsTwoFactor {
                TextField("Authenticator code", text: $twoFactorCode)
                    .keyboardType(.numbersAndPunctuation).textContentType(.oneTimeCode).textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Two-factor code")
                Text("Two-factor authentication is on: enter the current code from your authenticator app, or a recovery code.")
                    .font(.caption).foregroundColor(Theme.textSecondary)
            }
            if challengeId != nil {
                Text(challengeDetail).font(.footnote).foregroundColor(Theme.textSecondary)
                HStack {
                    TextField("6-digit code", text: $withdrawCode)
                        .keyboardType(.numberPad).textContentType(.oneTimeCode).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Email code")
                    Button(withdrawing ? "Paying…" : "Confirm") { Task { await withdraw(withCode: true) } }
                        .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent).disabled(withdrawing)
                }
            } else {
                Button(withdrawing ? "Sending code…" : "Email me a code") { Task { await withdraw(withCode: false) } }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).foregroundColor(Theme.onAccent)
                    .disabled(withdrawing || policy?.paused == true || policy?.lightningEnabled == false)
            }
            if let m = withdrawMessage {
                Text(m.text).font(.footnote).foregroundColor(m.ok ? Theme.green : Theme.red)
            }
            Text(policyLine(policy)).font(.caption).foregroundColor(Theme.textMuted)
        }
    }

    private var activityCard: some View {
        card {
            Text("Activity").font(.headline).foregroundColor(Theme.textPrimary)
            let rows = overview?.recent ?? []
            if rows.isEmpty {
                Text(purchasePolicy.canBuyInApp ? "Nothing yet. Buy cSats or connect a machine to get started." : "Nothing yet.").font(.footnote).foregroundColor(Theme.textSecondary)
            }
            ForEach(rows) { r in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(WalletFormat.reason(r.reason)).font(.subheadline).foregroundColor(Theme.textPrimary)
                        Text(WalletFormat.time(r.atMs)).font(.caption).foregroundColor(Theme.textMuted)
                    }
                    Spacer()
                    Text("\(r.type == "earn" ? "+" : "−")\(WalletFormat.num(abs(r.cSats), digits: 3))")
                        .font(.subheadline).monospacedDigit().foregroundColor(r.type == "earn" ? Theme.green : Theme.textPrimary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Pieces

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) { content() }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSurface)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.border))
    }

    private func pill(_ text: String) -> some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundColor(Theme.textSecondary)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .overlay(Capsule().stroke(Theme.borderStrong))
    }

    private func mini(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundColor(Theme.textSecondary)
            Text(value).font(.headline).monospacedDigit().foregroundColor(Theme.textPrimary)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgBase).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func presetButton(title: String, subtitle: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title).font(.subheadline.weight(.medium)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                Text(subtitle).font(.caption2).foregroundColor(Theme.textSecondary)
            }
            .foregroundColor(Theme.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(selected ? Theme.accent.opacity(0.12) : Theme.bgBase)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(selected ? Theme.accent : Theme.borderStrong, lineWidth: selected ? 1.5 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// feeLabel nil: no purchase fee, so no fee line.
    private func breakdown(pay: String, payUsd: String?, feeLabel: String?, fee: String, getLabel: String, get: String) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(Theme.border)
            row("You pay", pay, sub: payUsd)
            Divider().overlay(Theme.border)
            if let feeLabel {
                row(feeLabel, fee)
                Divider().overlay(Theme.border)
            }
            row(getLabel, get, bold: true)
            Divider().overlay(Theme.border)
        }
    }

    private func row(_ label: String, _ value: String, sub: String? = nil, bold: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(bold ? .subheadline.weight(.semibold) : .subheadline).foregroundColor(bold ? Theme.textPrimary : Theme.textSecondary)
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(value).font(bold ? .subheadline.weight(.semibold) : .subheadline).monospacedDigit().foregroundColor(Theme.textPrimary)
                if let sub { Text(sub).font(.caption).foregroundColor(Theme.textMuted) }
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 9, height: 9).accessibilityHidden(true)
            Text(text).font(.footnote).foregroundColor(Theme.textSecondary)
        }
    }

    private func kpi(_ label: String, _ value: String, _ detail: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundColor(Theme.textSecondary)
            Text(value).font(.headline).monospacedDigit().foregroundColor(tint)
            Text(detail).font(.caption2).foregroundColor(Theme.textMuted).lineLimit(2)
        }
        .padding(12).frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .background(Theme.bgSurface).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border))
        .accessibilityElement(children: .combine)
    }

    private func method(_ icon: String, _ title: String, _ detail: String, active: Bool, badge: String = "Active") -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundColor(active ? Theme.accent : Theme.textMuted).frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundColor(Theme.textPrimary)
                    Spacer()
                    Text(active ? badge : "Coming soon").font(.caption2.weight(.semibold))
                        .foregroundColor(active ? Theme.green : Theme.textMuted)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .overlay(Capsule().stroke(active ? Theme.green.opacity(0.5) : Theme.borderStrong))
                }
                Text(detail).font(.caption).foregroundColor(Theme.textSecondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(active ? Theme.accent : Theme.border, lineWidth: active ? 1.5 : 1))
        .opacity(active ? 1 : 0.7)
        .accessibilityElement(children: .combine)
    }

    private func policyLine(_ p: WalletOverview.PayoutPolicy?) -> String {
        guard let p else { return "Payout details are unavailable right now." }
        if p.lightningEnabled == false { return "Lightning payouts are not enabled on this coordinator yet." }
        var parts = ["Minimum \(WalletFormat.sats(Double(p.minPayoutSats ?? 0))) sats.", "Routing fee up to \(WalletFormat.pct(p.maxFeeBps ?? 0)) is set aside and the unused part returned."]
        if let daily = overview?.launch?.maxPayoutSatsPerDay, daily > 0 {
            parts.append("Early access: up to \(WalletFormat.sats(daily)) sats withdrawn per 24 h.")
        }
        if let single = p.limits?.maxSingleSats {
            parts.append("Up to \(WalletFormat.sats(Double(single))) sats per payout\(p.limits?.maxAccountDailySats.map { " and \(WalletFormat.sats(Double($0))) per 24 h" } ?? "").")
        }
        return parts.joined(separator: " ")
    }

    private func countdown(until: Date, now: Date) -> String {
        let s = max(0, Int(until.timeIntervalSince(now).rounded()))
        return s > 0 ? String(format: "Expires in %d:%02d", s / 60, s % 60) : "Expiring…"
    }

    // MARK: Actions

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            overview = try await APIClient.shared.request(baseURL: portal, path: "/portal/api/wallet/overview")
            loadError = ""
        } catch {
            loadError = "Could not load your wallet: \(error.localizedDescription)"
        }
        destination = try? await APIClient.shared.request(baseURL: portal, path: "/wallet/payout-destination")
    }

    private func createInvoice() async {
        guard amountValid else { return }
        creating = true
        topupError = ""
        defer { creating = false }
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: portal, path: "/portal/api/wallet/topup", method: "POST", body: ["amountSats": chosenAmount])
            guard r.status == 200, let inv = try? JSONDecoder().decode(TopupInvoice.self, from: r.data) else {
                struct Refusal: Decodable { let error: String?; let code: String?; let remainingSats: Double?; let limitSats: Double? }
                let f = try? JSONDecoder().decode(Refusal.self, from: r.data)
                topupError = BuyLimits.errorText(f?.code ?? f?.error ?? (r.status == 429 ? "rate_limited" : r.status == 401 ? "not_authenticated" : nil),
                                                 remainingSats: f?.remainingSats, limitSats: f?.limitSats)
                return
            }
            invoice = inv
            expiresAt = Date().addingTimeInterval(TimeInterval(inv.expiresInSeconds))
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { step = .invoice }
            startPolling(inv.intentId)
        } catch {
            topupError = "Could not start the payment: \(error.localizedDescription)"
        }
    }

    private func startPolling(_ intentId: String) {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if Task.isCancelled { return }
                guard let s: TopupStatus = try? await APIClient.shared.request(baseURL: portal, path: "/portal/api/wallet/topup/\(intentId)") else { continue }
                if s.status == "settled" {
                    paidCSats = s.cSats ?? invoice?.cSats ?? 0
                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.7)) { step = .paid }
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    await load()
                    return
                }
                if s.status == "expired" || Date() > expiresAt.addingTimeInterval(15) {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { step = .expired }
                    return
                }
            }
        }
    }

    private func openLightning() {
        onchainTask?.cancel()
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { step = .amount }
    }

    private func openOnchain() async {
        pollTask?.cancel()
        onchainError = ""
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { step = .onchain }
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: portal, path: "/portal/api/wallet/onchain/address", method: "POST", body: [String: String]())
            let o = try? JSONDecoder().decode(OnchainFunding.self, from: r.data)
            guard r.status == 200, let o, o.address != nil else {
                onchainError = o?.detail ?? "Could not get a deposit address (status \(r.status))."
                return
            }
            onchain = o
        } catch {
            onchainError = "Could not get a deposit address: \(error.localizedDescription)"
            return
        }
        onchainTask?.cancel()
        onchainTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if Task.isCancelled { return }
                if let o: OnchainFunding = try? await APIClient.shared.request(baseURL: portal, path: "/portal/api/wallet/onchain"), o.enabled { onchain = o }
            }
        }
    }

    private func backToAmount() {
        pollTask?.cancel()
        invoice = nil
        step = .amount
    }

    private func withdraw(withCode: Bool) async {
        withdrawMessage = nil
        let inv = bolt11.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !inv.isEmpty else { withdrawMessage = (false, "Paste a Lightning invoice first."); return }
        var body = ["bolt11": inv]
        if withCode {
            guard let id = challengeId, !withdrawCode.isEmpty else { withdrawMessage = (false, "Enter the code from the email."); return }
            body["challengeId"] = id
            body["emailCode"] = withdrawCode.trimmingCharacters(in: .whitespaces)
        }
        let tfa = twoFactorCode.trimmingCharacters(in: .whitespaces)
        if needsTwoFactor {
            guard !tfa.isEmpty else { withdrawMessage = (false, "Enter the code from your authenticator app."); return }
            body["twoFactorCode"] = tfa
        }
        withdrawing = true
        defer { withdrawing = false }
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: portal, path: "/wallet/payouts/withdraw", method: "POST", body: body)
            let w = try? JSONDecoder().decode(WithdrawResponse.self, from: r.data)
            switch WithdrawStep.classify(status: r.status, response: w) {
            case .twoFactorCode(let detail):
                needsTwoFactor = true
                withdrawMessage = (false, detail)
                return
            case .passkeyOnWeb:
                withdrawMessage = (false, "This account confirms withdrawals with a passkey. Withdraw on edgecoder.io (Settings > Wallet) for now.")
                return
            case .held(let detail):
                challengeId = nil
                withdrawMessage = (false, detail)
                return
            case .other:
                break
            }
            if r.status == 202, w?.verificationRequired == true {
                challengeId = w?.challengeId
                challengeDetail = "\(w?.detail ?? "We emailed you a code.") Amount: \(WalletFormat.msat(w?.amountMsat ?? 0)) sats."
                withdrawCode = ""
                return
            }
            challengeId = nil
            if (200...299).contains(r.status), w?.ok == true {
                withdrawMessage = (true, "Paid \(WalletFormat.msat(w?.payout?.amountMsat ?? 0)) sats to your wallet. A receipt is on its way by email.")
                bolt11 = ""
                twoFactorCode = ""
                needsTwoFactor = false
            } else {
                withdrawMessage = (false, w?.detail ?? "Withdrawal failed (\(w?.code ?? w?.error ?? "status \(r.status)")).")
            }
            await load()
        } catch {
            withdrawMessage = (false, "Withdrawal failed: \(error.localizedDescription)")
        }
    }
}

