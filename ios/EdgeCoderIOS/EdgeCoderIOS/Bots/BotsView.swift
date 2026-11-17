import SwiftUI

/// Bots on your desktop machines (the web's Bots page): see each bot, message it, pause or resume
/// it, and answer its approvals when the machine allows control from the web.
struct BotsView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @State private var machines: [BotMachine] = []
    @State private var bots: [BotSummary] = []
    @State private var loading = false
    @State private var error = ""
    @State private var loaded = false

    private var portal: URL { APIClient.shared.config.portalBaseURL }

    var body: some View {
        NavigationStack {
            List {
                if !sessionStore.isAuthenticated {
                    Text("Sign in to see the bots on your machines.").foregroundColor(Theme.textSecondary)
                } else if !error.isEmpty {
                    Text(error).foregroundColor(Theme.red)
                } else if loaded && bots.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No bots yet").font(.headline).foregroundColor(Theme.textPrimary)
                        Text(machines.isEmpty
                             ? "Bots run on the EdgeCoder desktop app. Sign in there with this account and they show up here."
                             : "Create a bot in the EdgeCoder desktop app on one of your machines and it shows up here.")
                            .font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                }
                ForEach(machines) { m in
                    let mine = bots.filter { $0.machine?.agentId == m.agentId }
                    if !mine.isEmpty {
                        Section {
                            ForEach(mine) { b in
                                NavigationLink {
                                    BotDetailView(agentId: m.agentId, botId: b.botId, title: b.name)
                                } label: {
                                    BotRow(bot: b)
                                }
                            }
                        } header: {
                            HStack(spacing: 6) {
                                Circle().fill(m.online ? Theme.green : Theme.textMuted).frame(width: 7, height: 7)
                                Text(m.machineName)
                                Text(m.online ? (m.controls == "on" ? "online" : "online · view only") : "offline")
                                    .foregroundColor(Theme.textMuted)
                            }
                        }
                    }
                }
            }
            .overlay { if loading && !loaded { ProgressView() } }
            .navigationTitle("Bots")
            .refreshable { await load() }
            .task(id: sessionStore.isAuthenticated) { await load() }
        }
    }

    private func load() async {
        guard sessionStore.isAuthenticated else { machines = []; bots = []; return }
        loading = true
        defer { loading = false; loaded = true }
        do {
            let r: BotsListResponse = try await APIClient.shared.request(baseURL: portal, path: "/portal/api/bots")
            machines = r.machines.sorted { ($0.online ? 0 : 1, $0.machineName) < ($1.online ? 0 : 1, $1.machineName) }
            bots = r.bots
            error = ""
        } catch {
            self.error = "Couldn't load your bots: \(error.localizedDescription)"
        }
    }
}

private struct BotRow: View {
    let bot: BotSummary
    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(Color(hex: bot.color) ?? Theme.accent).frame(width: 28, height: 28)
                .overlay(Text(String(bot.name.prefix(1)).uppercased()).font(.caption.weight(.bold)).foregroundColor(.white))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name).font(.subheadline.weight(.medium)).foregroundColor(Theme.textPrimary)
                Text(BotsFormat.status(bot)).font(.caption).foregroundColor(bot.isPaused ? Theme.yellow : Theme.textSecondary).lineLimit(1)
            }
            Spacer()
            if let n = bot.pending?.count, n > 0 {
                Text("\(n) to approve").font(.caption2.weight(.semibold)).foregroundColor(Theme.accent)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct BotDetailView: View {
    let agentId: String
    let botId: String
    let title: String

    @State private var bot: BotSummary?
    @State private var machine: BotMachine?
    @State private var draft = ""
    @State private var sending = false
    @State private var note: (ok: Bool, text: String)?
    @State private var loadError = ""

    private var portal: URL { APIClient.shared.config.portalBaseURL }
    private var basePath: String { "/portal/api/bots/\(agentId)/\(botId)" }
    private var canControl: Bool { machine?.canControl == true }

    var body: some View {
        List {
            if !loadError.isEmpty { Text(loadError).foregroundColor(Theme.red) }
            if let bot {
                Section {
                    LabeledContent("Status", value: BotsFormat.status(bot))
                    if let folder = bot.folderName, !folder.isEmpty { LabeledContent("Folder", value: folder) }
                    if let runs = bot.runsToday { LabeledContent("Runs today", value: "\(runs)\(bot.maxRunsPerDay.map { " of \($0)" } ?? "")") }
                    if let spent = bot.spentTodayCSats {
                        LabeledContent("Spent today", value: ChatFailures.formatCSats(spent) + (bot.budgetCSatsPerDay.map { " of \(ChatFailures.formatCSats($0))" } ?? ""))
                    }
                    if let run = bot.lastRun, let summary = run.summary, !summary.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Last run").font(.caption).foregroundColor(Theme.textMuted)
                            Text(summary).font(.footnote).foregroundColor(Theme.textPrimary)
                        }
                    }
                    if canControl {
                        HStack {
                            Button(bot.isPaused ? "Resume" : "Pause") { Task { await command(bot.isPaused ? "resume" : "pause") } }
                                .buttonStyle(.bordered)
                            Button("Check now") { Task { await command("check_now") } }
                                .buttonStyle(.bordered)
                                .disabled(bot.isPaused)
                        }
                        .disabled(sending)
                    } else {
                        Text(machine?.online == false ? "This machine is offline. You can read, but not control, its bots." : "View only: approve and control this bot on the Mac.")
                            .font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                }
                if let pending = bot.pending, !pending.isEmpty {
                    Section("Waiting for approval") {
                        ForEach(pending) { call in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(call.tool).font(.caption.weight(.semibold)).foregroundColor(Theme.textPrimary)
                                Text(call.detail).font(.system(.caption, design: .monospaced)).foregroundColor(Theme.textSecondary)
                                if canControl {
                                    HStack {
                                        Button("Approve") { Task { await command("approve", args: ["callId": call.callId, "approved": true]) } }
                                            .buttonStyle(.borderedProminent).tint(Theme.accent)
                                        Button("Deny", role: .destructive) { Task { await command("approve", args: ["callId": call.callId, "approved": false]) } }
                                            .buttonStyle(.bordered)
                                    }
                                    .disabled(sending)
                                }
                            }
                        }
                    }
                }
                Section("Messages") {
                    let tail = bot.tail ?? []
                    if tail.isEmpty { Text("No messages yet.").font(.footnote).foregroundColor(Theme.textSecondary) }
                    ForEach(tail) { m in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(m.role == "user" ? "You" : m.role == "event" ? "Event" : bot.name)
                                .font(.caption.weight(.semibold))
                                .foregroundColor(m.role == "user" ? Theme.accent : Theme.textMuted)
                            Text(m.content).font(.footnote).foregroundColor(Theme.textPrimary).textSelection(.enabled)
                            ForEach(Array((m.steps ?? []).enumerated()), id: \.offset) { _, step in
                                Text("\(step.tool) · \(step.detail)").font(.system(.caption2, design: .monospaced))
                                    .foregroundColor(step.status == "error" || step.status == "denied" ? Theme.red : Theme.textMuted)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            } else if loadError.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if canControl {
                VStack(spacing: 4) {
                    if let note { Text(note.text).font(.caption).foregroundColor(note.ok ? Theme.green : Theme.red) }
                    HStack(alignment: .bottom) {
                        TextField("Message \(title)…", text: $draft, axis: .vertical)
                            .lineLimit(1...5)
                            .textFieldStyle(.roundedBorder)
                        Button {
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            Task {
                                if await command("message", args: ["content": text]) { draft = "" }
                            }
                        } label: {
                            Image(systemName: "arrow.up.circle.fill").font(.title2)
                        }
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                        .accessibilityLabel("Send message")
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(.bar)
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let r: BotDetailResponse = try await APIClient.shared.request(baseURL: portal, path: basePath)
            bot = r.bot
            machine = r.machine
            loadError = ""
        } catch {
            loadError = BotsFormat.commandError((error as? APIClientError).flatMap { if case .serverError(let s) = $0 { return s } else { return nil } }, message: error.localizedDescription)
        }
    }

    /// Sends one bot command; the desktop picks it up within seconds, then the bot is reloaded.
    @discardableResult
    private func command(_ action: String, args: [String: Any] = [:]) async -> Bool {
        sending = true
        note = nil
        defer { sending = false }
        struct Body: Encodable {
            let action: String
            let args: [String: JSONValue]
        }
        let body = Body(action: action, args: args.compactMapValues(JSONValue.init))
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: portal, path: "\(basePath)/commands", method: "POST", body: body)
            let res = try? JSONDecoder().decode(BotCommandResponse.self, from: r.data)
            guard r.status == 200, res?.ok == true else {
                note = (false, BotsFormat.commandError(res?.error, message: res?.message))
                return false
            }
            note = (true, action == "message" ? "Sent." : "Done.")
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await load()
            return true
        } catch {
            note = (false, "The command didn't go through: \(error.localizedDescription)")
            return false
        }
    }
}

/// A JSON scalar for command args.
enum JSONValue: Encodable {
    case string(String), bool(Bool), number(Double)
    init?(_ any: Any) {
        if let b = any as? Bool { self = .bool(b) }
        else if let s = any as? String { self = .string(s) }
        else if let n = any as? Double { self = .number(n) }
        else if let n = any as? Int { self = .number(Double(n)) }
        else { return nil }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        }
    }
}

extension Color {
    /// "#RRGGBB" (a bot's color); nil when malformed.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
