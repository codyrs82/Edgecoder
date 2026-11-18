import SwiftUI

/// Bots in the cloud and on your desktop machines (the web's Bots page): see each bot, message it,
/// pause or resume it, answer its approvals when the machine allows control from the web, and
/// create new ones (in the cloud, no machine needed, or on one of your machines).
struct BotsView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @State private var machines: [BotMachine] = []
    @State private var bots: [BotSummary] = []
    @State private var loading = false
    @State private var error = ""
    @State private var loaded = false
    @State private var pending: [PendingBot] = []
    @State private var cloudTarget: BotTarget?
    @State private var machineTargets: [BotTarget] = []
    @State private var cloudGitHub = true
    @State private var showNew = false

    private var portal: URL { APIClient.shared.config.portalBaseURL }
    private var cloudBots: [BotSummary] { bots.filter(\.isCloud) }

    var body: some View {
        NavigationStack {
            List {
                if !sessionStore.isAuthenticated {
                    Text("Sign in to see your bots.").foregroundColor(Theme.textSecondary)
                } else if !error.isEmpty {
                    Text(error).foregroundColor(Theme.red)
                } else if loaded && bots.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("No bots yet").font(.headline).foregroundColor(Theme.textPrimary)
                        Text(cloudTarget != nil
                             ? "Tap + to create one. A cloud bot needs no machine."
                             : machines.isEmpty
                                ? "Tap + to create one, or sign in to the EdgeCoder desktop app on one of your machines and its bots show up here."
                                : "Tap + to create one on one of your machines, or create it in the EdgeCoder desktop app.")
                            .font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                }
                if !pending.isEmpty {
                    Section("New bots") {
                        ForEach(pending) { p in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(p.name).font(.subheadline.weight(.medium)).foregroundColor(Theme.textPrimary)
                                Text(BotsFormat.pendingState(p)).font(.caption).foregroundColor(p.state == "failed" ? Theme.red : Theme.textSecondary)
                            }
                        }
                    }
                }
                if !cloudBots.isEmpty {
                    Section {
                        ForEach(cloudBots) { b in
                            NavigationLink {
                                BotDetailView(agentId: BotTarget.cloudId, botId: b.botId, title: b.name) { Task { await load() } }
                            } label: {
                                BotRow(bot: b)
                            }
                        }
                    } header: {
                        Label("Cloud", systemImage: "cloud")
                    }
                }
                ForEach(machines.filter { $0.agentId != BotTarget.cloudId }) { m in
                    let mine = bots.filter { !$0.isCloud && $0.machine?.agentId == m.agentId }
                    if !mine.isEmpty {
                        Section {
                            ForEach(mine) { b in
                                NavigationLink {
                                    BotDetailView(agentId: m.agentId, botId: b.botId, title: b.name) { Task { await load() } }
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
            .toolbar {
                if sessionStore.isAuthenticated {
                    ToolbarItem(placement: .primaryAction) {
                        Button { showNew = true } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New bot")
                    }
                }
            }
            .sheet(isPresented: $showNew) {
                NewBotSheet(cloudTarget: cloudTarget, machineTargets: machineTargets, cloudGitHub: cloudGitHub) { Task { await load() } }
            }
            .refreshable { await load() }
            .task(id: sessionStore.isAuthenticated) { await load() }
        }
    }

    private func load() async {
        guard sessionStore.isAuthenticated else { machines = []; bots = []; pending = []; cloudTarget = nil; machineTargets = []; return }
        loading = true
        defer { loading = false; loaded = true }
        do {
            let r: BotsListResponse = try await fetchList()
            machines = r.machines.sorted { ($0.online ? 0 : 1, $0.machineName) < ($1.online ? 0 : 1, $1.machineName) }
            bots = r.bots
            pending = r.pending ?? []
            cloudTarget = r.cloudTarget
            machineTargets = r.machineTargets
            cloudGitHub = r.cloudGitHub
            error = ""
        } catch {
            self.error = "Couldn't load your bots: \(error.localizedDescription)"
        }
    }
}

extension BotsView {
    /// GET /portal/api/bots (the sample list for Debug screenshots).
    fileprivate func fetchList() async throws -> BotsListResponse {
        #if DEBUG
        if ScreenshotFixture.isEnabled, let r = ScreenshotFixture.bots { return r }
        #endif
        return try await APIClient.shared.request(baseURL: portal, path: "/portal/api/bots")
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
                HStack(spacing: 6) {
                    Text(bot.name).font(.subheadline.weight(.medium)).foregroundColor(Theme.textPrimary)
                    if bot.isCloud {
                        Text("Cloud").font(.caption2.weight(.semibold)).foregroundColor(Theme.accentSecondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .overlay(Capsule().stroke(Theme.accentSecondary.opacity(0.6), lineWidth: 1))
                    }
                }
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
    /// "cloud" for a cloud bot, else the machine's agent id.
    let agentId: String
    let botId: String
    let title: String
    /// The list reloads (after a delete).
    var onChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var bot: BotSummary?
    @State private var machine: BotMachine?
    @State private var draft = ""
    @State private var sending = false
    @State private var waitingReply = false
    @State private var note: (ok: Bool, text: String)?
    @State private var loadError = ""
    @State private var confirmDelete = false

    private var portal: URL { APIClient.shared.config.portalBaseURL }
    /// Cloud bots: /portal/api/bots/cloud/:botId (the same shape as a machine's bots).
    private var basePath: String { "/portal/api/bots/\(agentId)/\(botId)" }
    private var isCloud: Bool { agentId == BotTarget.cloudId }
    private var canControl: Bool { isCloud ? (machine?.canControl ?? true) : machine?.canControl == true }

    var body: some View {
        List {
            if !loadError.isEmpty { Text(loadError).foregroundColor(Theme.red) }
            if let bot {
                Section {
                    LabeledContent("Status", value: BotsFormat.status(bot))
                    LabeledContent("Runs on", value: isCloud ? "Cloud" : (machine?.machineName ?? bot.machine?.machineName ?? "Your machine"))
                    if let folder = bot.folderName, !folder.isEmpty { LabeledContent("Folder", value: folder) }
                    if let c = bot.cloud {
                        LabeledContent("Model", value: c.modelLabel)
                        if let web = c.web { LabeledContent("Search the web", value: web ? "On" : "Off") }
                        if let repo = c.github?.repo, !repo.isEmpty { LabeledContent("GitHub", value: repo) }
                    }
                    if let schedule = bot.schedule, !schedule.isEmpty { LabeledContent("Schedule", value: schedule) }
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
                            if bot.isRunning {
                                Button("Stop", role: .destructive) { Task { await command("stop") } }
                                    .buttonStyle(.bordered)
                            } else {
                                Button("Check now") { Task { await command("check_now") } }
                                    .buttonStyle(.bordered)
                                    .disabled(bot.isPaused)
                            }
                        }
                        .disabled(sending)
                    } else {
                        Text(machine?.online == false ? "This machine is offline. You can read, but not control, its bots." : "View only: approve and control this bot on its machine.")
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
                    if waitingReply {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Waiting for a reply…").font(.caption).foregroundColor(Theme.textSecondary)
                        }
                    }
                }
                if isCloud && canControl {
                    Section {
                        Button("Delete bot", role: .destructive) { confirmDelete = true }
                            .disabled(sending)
                    }
                }
            } else if loadError.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Delete \(title)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete bot", role: .destructive) {
                Task {
                    if await command("delete", reload: false) {
                        onChanged()
                        dismiss()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The bot and its messages are removed. This can't be undone.")
        }
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
        #if DEBUG
        if ScreenshotFixture.isEnabled {
            bot = ScreenshotFixture.bots?.bots.first { $0.botId == botId }
            machine = bot?.machine
            return
        }
        #endif
        do {
            let r: BotDetailResponse = try await APIClient.shared.request(baseURL: portal, path: basePath)
            bot = r.bot
            machine = r.machine
            loadError = ""
        } catch {
            loadError = BotsFormat.commandError((error as? APIClientError).flatMap { if case .serverError(let s) = $0 { return s } else { return nil } }, message: error.localizedDescription)
        }
    }

    /// Sends one bot command, then reloads the bot while the command runs (a message: until the
    /// bot's reply shows up, or about 40 seconds).
    @discardableResult
    private func command(_ action: String, args: [String: Any] = [:], reload: Bool = true) async -> Bool {
        sending = true
        note = nil
        struct Body: Encodable {
            let action: String
            let args: [String: JSONValue]
        }
        let body = Body(action: action, args: args.compactMapValues(JSONValue.init))
        let lastBefore = bot?.tail?.last?.id
        let commandId: String?
        var inlineResult: BotCommandState.Result?
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: portal, path: "\(basePath)/commands", method: "POST", body: body)
            let res = try? JSONDecoder().decode(BotCommandResponse.self, from: r.data)
            guard r.status == 200, res?.accepted == true else {
                sending = false
                note = (false, BotsFormat.commandError(res?.error, message: res?.message))
                return false
            }
            commandId = res?.commandId
            inlineResult = res?.result
        } catch {
            sending = false
            note = (false, "The command didn't go through: \(error.localizedDescription)")
            return false
        }
        sending = false
        note = (true, action == "message" ? "Sent." : "Done.")
        guard reload else { return true }
        if isCloud {
            await followCloud(action, commandId: commandId, inline: inlineResult)
            return true
        }
        if action == "message" { waitingReply = true }
        defer { waitingReply = false }
        var finished = commandId == nil
        for i in 0..<20 {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { break }
            await load()
            if !finished, let commandId,
               let st: BotCommandState = try? await APIClient.shared.request(baseURL: portal, path: "/portal/api/bots/\(agentId)/commands/\(commandId)") {
                if st.isFinished {
                    finished = true
                    if st.failed {
                        note = (false, BotsFormat.commandError(st.result?.error, message: st.result?.message))
                        break
                    }
                }
            }
            if action == "message" {
                if let last = bot?.tail?.last, last.id != lastBefore, last.role != "user" { break }
            } else if finished || i >= 2 {
                break
            }
        }
        return true
    }
}

extension BotDetailView {
    /// A cloud command answers inline, so only a message is followed: its id is the message id, and
    /// GET …/cloud/commands/:id (any portal machine) gives its run's status until the run ends.
    fileprivate func followCloud(_ action: String, commandId: String?, inline: BotCommandState.Result?) async {
        if let r = inline, ["refused", "failed", "error"].contains(r.status ?? "") {
            note = (false, BotsFormat.commandError(r.error, message: r.message))
        }
        guard action == "message", let commandId else {
            await load()
            return
        }
        waitingReply = true
        defer { waitingReply = false }
        // Up to about 3 minutes: a run can take a while; the detail reloads as it goes.
        for i in 0..<60 {
            try? await Task.sleep(nanoseconds: (i < 10 ? 2 : 4) * 1_000_000_000)
            if Task.isCancelled { return }
            let st: BotCommandState? = try? await APIClient.shared.request(baseURL: portal, path: "/portal/api/bots/cloud/commands/\(commandId)")
            await load()
            if st?.runFinished == true || (st != nil && st?.run == nil) { return }
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

/// Create a bot from the phone. In the cloud it is made at once and needs no machine; on one of your
/// machines it waits on the portal until that machine takes it (#414), and its folder is picked there.
private struct NewBotSheet: View {
    let cloudTarget: BotTarget?
    let machineTargets: [BotTarget]
    /// GitHub is set up for cloud bots on this portal (`cloud.github` on the list).
    var cloudGitHub: Bool = true
    let onCreated: () -> Void

    private enum ScheduleKind: Hashable { case none, everyHours, daily }

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var role = ""
    @State private var instructions = ""
    /// "cloud", a machine's agent id, or nil: the first of your machines available.
    @State private var target: String?
    @State private var model: BotModelChoice = .auto
    @State private var modelChoices: [BotModelChoice] = [.auto]
    @State private var web = true
    @State private var scheduleKind: ScheduleKind = .none
    @State private var everyHours = 4
    @State private var dailyTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var repo = ""
    /// Sent once with the request; never written to the device.
    @State private var token = ""
    @State private var onPrOpened = false
    @State private var onCiFailed = false
    @State private var onIssueLabeled = false
    /// The portal's default label.
    @State private var issueLabel = "bot"
    /// One per sheet: a retry of "Create" sends the same one, so the bot is made once.
    @State private var requestId = UUID().uuidString
    @State private var saving = false
    @State private var error = ""

    private var hasTargets: Bool { cloudTarget != nil || !machineTargets.isEmpty }
    private var isCloud: Bool { target == BotTarget.cloudId }
    private var repoTrimmed: String { repo.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var normalizedRepo: String? { BotSchedule.normalizeRepo(repo) }
    private var labelTrimmed: String { issueLabel.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tokenTrimmed: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// GitHub can't be used: a cloud bot on a portal without the token store.
    private var gitHubUnavailable: Bool { isCloud && !cloudGitHub }
    /// A machine uses the GitHub account signed in there; the token is for cloud bots.
    private var showsToken: Bool { isCloud }

    private var schedule: BotScheduleChoice {
        switch scheduleKind {
        case .none: return .none
        case .everyHours: return .everyHours(everyHours)
        case .daily:
            let c = Calendar.current.dateComponents([.hour, .minute], from: dailyTime)
            return .daily(hour: c.hour ?? 9, minute: c.minute ?? 0)
        }
    }

    private var github: NewBotRequest.GitHub? {
        guard !gitHubUnavailable, let repo = normalizedRepo else { return nil }
        var triggers: [BotGitHubTrigger] = []
        if onPrOpened { triggers.append(.prOpened) }
        if onCiFailed { triggers.append(.ciFailed) }
        if onIssueLabeled { triggers.append(.issueLabeled(String(labelTrimmed.prefix(50)))) }
        let t = showsToken ? tokenTrimmed : ""
        return .init(repo: repo, token: t.isEmpty ? nil : t, triggers: triggers)
    }

    private var invalidReason: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "" }
        if !hasTargets { return "" }
        if case .everyHours(let h) = schedule, h * 60 < BotSchedule.minEveryMinutes { return "A schedule runs at most every 15 minutes." }
        if gitHubUnavailable { return nil }
        if !repoTrimmed.isEmpty && normalizedRepo == nil { return "Enter the repository as owner/name." }
        if showsToken && normalizedRepo != nil && !tokenTrimmed.isEmpty && !BotSchedule.isPlausibleToken(tokenTrimmed) { return "That doesn't look like a GitHub token." }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Role (optional)", text: $role)
                }
                Section("Instructions") {
                    TextField("What should this bot do?", text: $instructions, axis: .vertical).lineLimit(4...10)
                }
                Section {
                    if hasTargets {
                        Picker("Runs on", selection: $target) {
                            if cloudTarget != nil {
                                Text("Cloud").tag(Optional(BotTarget.cloudId))
                            }
                            if !machineTargets.isEmpty {
                                Text("First machine available").tag(String?.none)
                                ForEach(machineTargets) { t in
                                    Text(t.machineName + (t.online ? "" : " (offline)")).tag(Optional(t.agentId))
                                }
                            }
                        }
                    } else {
                        Text("There's nowhere to run a bot yet. Cloud bots aren't available yet, and none of your machines can host bots. Sign in to the EdgeCoder desktop app on one of your machines to run bots there.")
                            .font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                } footer: {
                    if hasTargets {
                        Text(isCloud
                             ? "No machine needed. It runs in the cloud."
                             : "The bot is created on that machine the next time EdgeCoder runs there. You pick its project folder on that machine.")
                    }
                }
                Section {
                    Picker("Model", selection: $model) {
                        ForEach(modelChoices, id: \.self) { c in Text(c.label).tag(c) }
                    }
                    Toggle("Search the web", isOn: $web)
                } footer: {
                    Text(modelFooter)
                }
                Section {
                    Picker("Schedule", selection: $scheduleKind) {
                        Text("None").tag(ScheduleKind.none)
                        Text("Every few hours").tag(ScheduleKind.everyHours)
                        Text("Daily").tag(ScheduleKind.daily)
                    }
                    if scheduleKind == .everyHours {
                        Stepper("Every \(everyHours) hour\(everyHours == 1 ? "" : "s")", value: $everyHours, in: 1...24)
                    } else if scheduleKind == .daily {
                        DatePicker("At", selection: $dailyTime, displayedComponents: .hourAndMinute)
                    }
                } footer: {
                    if case .daily(let h, let m) = schedule {
                        Text("Runs every day at \(String(format: "%02d:%02d", h, m)) your time (\(BotSchedule.utcTime(hour: h, minute: m, in: .current, on: Date())) UTC).")
                    } else {
                        Text("It also runs when you message it.")
                    }
                }
                Section {
                    TextField("Repository (owner/name)", text: $repo)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .disabled(gitHubUnavailable)
                    if showsToken {
                        SecureField("Token (optional)", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(normalizedRepo == nil || gitHubUnavailable)
                    }
                    Group {
                        Toggle("Pull request opened", isOn: $onPrOpened)
                        Toggle("CI failed", isOn: $onCiFailed)
                        Toggle("Issue labeled", isOn: $onIssueLabeled)
                        if onIssueLabeled {
                            TextField("Label (default: bot)", text: $issueLabel)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    .disabled(normalizedRepo == nil || gitHubUnavailable)
                } header: {
                    Text("GitHub (optional)")
                } footer: {
                    if gitHubUnavailable {
                        Text("GitHub isn't set up for cloud bots yet.")
                    } else if repoTrimmed.isEmpty {
                        Text("Add a repository to use triggers.")
                    } else if normalizedRepo == nil {
                        Text("Enter the repository as owner/name.")
                    } else if showsToken {
                        Text("The token is sent once to create the bot and isn't saved on this device.")
                    } else {
                        Text("The machine uses the GitHub account signed in there.")
                    }
                }
                if let reason = invalidReason, !reason.isEmpty {
                    Text(reason).font(.footnote).foregroundColor(Theme.textSecondary)
                }
                if !error.isEmpty { Text(error).foregroundColor(Theme.red) }
            }
            .navigationTitle("New bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { token = ""; dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(invalidReason != nil || saving)
                }
            }
            .onAppear {
                if target == nil && cloudTarget != nil { target = BotTarget.cloudId }
            }
            .task { await loadModels() }
            .onDisappear { token = "" }
        }
    }

    private var modelFooter: String {
        switch model {
        case .auto: return "Auto picks a model on the network for each run."
        case .mine: return "Free. Runs only on your own machines."
        case .network: return "Runs on the EdgeCoder network, billed in cSats."
        }
    }

    /// The web chat's compute options; Auto only when they can't be read.
    private func loadModels() async {
        guard let r: ComputeOptionsResponse = try? await APIClient.shared.request(baseURL: APIClient.shared.config.portalBaseURL, path: "/portal/api/compute/options") else { return }
        modelChoices = r.modelChoices
        if !modelChoices.contains(model) { model = .auto }
    }

    private func create() async {
        saving = true
        error = ""
        defer { saving = false }
        let spec = NewBotRequest.Spec(
            name: String(name.trimmingCharacters(in: .whitespaces).prefix(60)),
            role: String(role.prefix(80)),
            instructions: String(instructions.prefix(8_000)),
            model: model, web: web, schedule: schedule, github: github)
        let body = NewBotRequest(requestId: requestId, agentId: target, bot: spec)
        do {
            let r = try await APIClient.shared.requestRaw(baseURL: APIClient.shared.config.portalBaseURL, path: "/portal/api/bots/new", method: "POST", body: body)
            let res = try? JSONDecoder().decode(BotCommandResponse.self, from: r.data)
            guard r.status == 200, res?.accepted == true else {
                error = BotsFormat.commandError(res?.error, message: res?.message)
                return
            }
            token = ""
            onCreated()
            dismiss()
        } catch {
            self.error = "Couldn't create the bot: \(error.localizedDescription)"
        }
    }
}
