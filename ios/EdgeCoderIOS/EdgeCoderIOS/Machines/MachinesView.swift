import SwiftUI

/// The signed-in account's machines (the web's Settings → Nodes): each one's name, whether it is
/// online, when it was last seen, the model it serves and how many bots run on it.
struct MachinesView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @State private var rows: [MachineRow] = []
    @State private var loading = false
    @State private var loaded = false
    @State private var error = ""

    private var portal: URL { APIClient.shared.config.portalBaseURL }

    var body: some View {
        NavigationStack {
            List {
                if !sessionStore.isAuthenticated {
                    Text("Sign in to see your machines.").foregroundColor(Theme.textSecondary)
                } else if !error.isEmpty {
                    Text(error).foregroundColor(Theme.red)
                } else if loaded && rows.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No machines yet").font(.headline).foregroundColor(Theme.textPrimary)
                        Text(MachinesDirectory.emptyMessage)
                            .font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                    .accessibilityIdentifier("machinesEmpty")
                }
                ForEach(rows) { MachineRowView(row: $0) }
            }
            .overlay { if loading && !loaded { ProgressView() } }
            .navigationTitle("Machines")
            .refreshable { await load() }
            .task(id: sessionStore.isAuthenticated) { await load() }
        }
    }

    private func load() async {
        guard sessionStore.isAuthenticated else { rows = []; loaded = false; error = ""; return }
        loading = true
        defer { loading = false; loaded = true }
        #if DEBUG
        if ScreenshotFixture.isEnabled, let m = ScreenshotFixture.machines {
            rows = MachinesDirectory.rows(machines: m, bots: ScreenshotFixture.bots)
            error = ""
            return
        }
        #endif
        async let machines: MachinesListResponse = APIClient.shared.request(baseURL: portal, path: "/portal/api/machines")
        // Names and bot counts; the list still shows without them.
        async let bots = loadBots()
        do {
            let m = try await machines
            rows = MachinesDirectory.rows(machines: m, bots: await bots)
            error = ""
        } catch {
            _ = await bots
            self.error = "Couldn't load your machines: \(error.localizedDescription)"
        }
    }
}

private func loadBots() async -> BotsListResponse? {
    let r: BotsListResponse? = try? await APIClient.shared.request(baseURL: APIClient.shared.config.portalBaseURL, path: "/portal/api/bots") as BotsListResponse
    return r
}

private struct MachineRowView: View {
    let row: MachineRow
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(row.online ? Theme.green : Theme.textMuted).frame(width: 9, height: 9).padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name).font(.subheadline.weight(.medium)).foregroundColor(Theme.textPrimary)
                Text(MachinesDirectory.status(row)).font(.caption).foregroundColor(row.online ? Theme.green : Theme.textSecondary)
                Text(row.model.map { "Model: \($0)" } ?? "Model: not reported").font(.caption).foregroundColor(Theme.textSecondary)
            }
            Spacer()
            if let n = row.botCount, n > 0 {
                Text(MachinesDirectory.botsLabel(n)).font(.caption2.weight(.semibold)).foregroundColor(Theme.accent)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
