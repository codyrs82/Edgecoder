import SwiftUI

/// One coding session on a computer: its transcript, tool steps, approvals, and a composer.
/// While a turn runs or waits for an approval the snapshot is fetched again every ~2.5 s (live
/// streaming comes later); polling stops when the view goes away or the app leaves the foreground.
struct CodeSessionView: View {
    @ObservedObject var store: CodeStore
    let agentId: String
    let sessionId: String

    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot: CodeSessionSnapshot?
    @State private var older: [CodeMessage] = []
    @State private var moreOlder = true
    @State private var loadError: String?
    @State private var note: String?
    @State private var draft = ""
    @State private var busy = false
    @State private var refreshing = false
    /// Polls left after a write, until the Mac reports the turn as running.
    @State private var kick = 0
    @State private var confirmUndo = false
    /// Full access was picked: the confirm alert is up.
    @State private var confirmFullAccess = false

    static let pollInterval: UInt64 = 2_500_000_000

    private var machine: CodeMachine? { store.machine(agentId) }
    private var canDrive: Bool { machine?.canDrive ?? false }
    private var status: CodeSessionStatus { snapshot?.status ?? .idle }
    private var pollKey: String { "\(scenePhase == .active)-\(status.isActive)-\(kick > 0)" }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if let snapshot {
                        header(snapshot)
                        if moreOlder && !snapshot.tail.isEmpty {
                            Button("Load earlier messages") { Task { await loadOlder() } }
                                .font(.callout)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 6)
                        }
                        ForEach(older + snapshot.tail) { m in
                            messageView(m)
                        }
                        if let running = snapshot.running {
                            runningView(running)
                        }
                        ForEach(snapshot.queue) { q in queuedView(q) }
                        ForEach(snapshot.pending) { p in
                            CodeApprovalCard(
                                approval: p, canDrive: canDrive, busy: busy, remoteModes: snapshot.session.remoteModes,
                                answer: { approved in
                                    Task { await act { try await store.api.approve(agentId: agentId, sessionId: sessionId, callId: p.callId, approved: approved) } }
                                },
                                allowForSession: {
                                    Task { await act { try await store.api.approve(agentId: agentId, sessionId: sessionId, callId: p.callId, approved: true, forSession: true) } }
                                }
                            )
                            .padding(.horizontal, 16)
                        }
                        if snapshot.awaitingPlanApproval && canDrive {
                            planCard
                        }
                    } else if let loadError {
                        CodeErrorBanner(text: loadError) { Task { await refresh() } }
                            .padding(16)
                    } else {
                        ProgressView("Asking your computer…")
                            .frame(maxWidth: .infinity)
                            .padding(.top, 60)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.vertical, 8)
            }
            .onChange(of: snapshot?.seq) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .background(Theme.bgBase)
        .navigationTitle(snapshot?.session.title ?? machine?.sessions.first { $0.sessionId == sessionId }?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .safeAreaInset(edge: .bottom) { bottomBar }
        .refreshable { await refresh() }
        .task {
            // Opened from the drawer before the machine list loaded: whether it can be driven comes from there.
            if machine == nil { store.refreshInBackground() }
            await refresh()
        }
        .task(id: pollKey) { await poll() }
        .confirmationDialog("Undo the last turn?", isPresented: $confirmUndo, titleVisibility: .visible) {
            Button("Undo last turn", role: .destructive) {
                Task { await act { try await store.api.undo(agentId: agentId, sessionId: sessionId, turnId: snapshot?.lastTurnId) } }
            }
        } message: {
            Text("Files the last turn changed go back to how they were before it.")
        }
        .alert(CodeMode.fullAccessConfirmTitle, isPresented: $confirmFullAccess) {
            Button("Turn on Full access", role: .destructive) {
                Task { await act { try await store.api.setMode(agentId: agentId, sessionId: sessionId, mode: .full, confirmFull: true) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(CodeMode.fullAccessConfirmMessage)
        }
    }

    // MARK: - Pieces

    private func header(_ s: CodeSessionSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                CodeStatusPill(text: status.label, color: status == .running ? Theme.green : status == .waiting ? Theme.accent : Theme.textMuted)
                Text([s.session.projectName, s.session.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Label(s.session.modeLabel, systemImage: s.session.mode == CodeMode.full.rawValue ? "exclamationmark.shield" : "shield.lefthalf.filled")
                    .foregroundColor(s.session.mode == CodeMode.full.rawValue ? Theme.accent : Theme.textMuted)
                    .accessibilityLabel("Mode: \(s.session.modeLabel)")
            }
            if let line = s.session.allowancesLine {
                Text(line)
                    .foregroundColor(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .foregroundColor(Theme.textMuted)
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    @ViewBuilder
    private func messageView(_ m: CodeMessage) -> some View {
        switch m.role {
        case "user":
            MessageBubble(message: ChatMessage(role: .user, content: m.content))
        case "assistant":
            VStack(alignment: .leading, spacing: 4) {
                if !m.steps.isEmpty { CodeStepsView(steps: m.steps).padding(.horizontal, 16) }
                if !m.content.isEmpty { MessageBubble(message: ChatMessage(role: .assistant, content: m.content)) }
                if let turnId = m.turnId, !m.changedFiles.isEmpty {
                    NavigationLink(value: CodeRoute.diff(agentId: agentId, sessionId: sessionId, turnId: turnId)) {
                        Label(m.undone ? "\(filesLabel(m.changedFiles.count)) (undone)" : filesLabel(m.changedFiles.count), systemImage: "doc.text.magnifyingglass")
                            .font(.callout.weight(.medium))
                    }
                    .padding(.horizontal, 16)
                    .accessibilityHint("Shows what this turn changed")
                } else if m.undone {
                    Text("Undone")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                        .padding(.horizontal, 16)
                }
            }
        default:
            Text(m.content)
                .font(.caption)
                .foregroundColor(Theme.textMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
    }

    private func filesLabel(_ n: Int) -> String {
        n == 1 ? "1 file changed" : "\(n) files changed"
    }

    private func runningView(_ r: CodeRunningTurn) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if !r.steps.isEmpty { CodeStepsView(steps: r.steps, expanded: true).padding(.horizontal, 16) }
            MessageBubble(message: ChatMessage(role: .assistant, content: r.text), streaming: status == .running, statusText: status == .waiting ? "Waiting for your approval" : "Working on your computer…")
        }
    }

    private func queuedView(_ q: CodeQueuedMessage) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "clock").foregroundColor(Theme.textMuted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Queued").font(.caption.weight(.semibold)).foregroundColor(Theme.textMuted)
                Text(q.text).font(.callout).foregroundColor(Theme.textPrimary).lineLimit(4)
            }
            Spacer(minLength: 0)
            if canDrive {
                Button {
                    Task { await act { try await store.api.unqueue(agentId: agentId, sessionId: sessionId, queuedId: q.id) } }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundColor(Theme.textMuted)
                }
                .accessibilityLabel("Remove queued message")
            }
        }
        .padding(12)
        .background(Theme.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal, 16)
    }

    private var planCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Approve this plan?")
                .font(.headline)
            Text("It starts making changes in the mode you pick.")
                .font(.callout)
                .foregroundColor(Theme.textSecondary)
            HStack {
                Button("Approve, ask first") {
                    Task { await act { try await store.api.approvePlan(agentId: agentId, sessionId: sessionId, mode: .ask) } }
                }
                .buttonStyle(.bordered)
                Button("Approve, accept edits") {
                    Task { await act { try await store.api.approvePlan(agentId: agentId, sessionId: sessionId, mode: .autoEdits) } }
                }
                .buttonStyle(.borderedProminent)
            }
            .disabled(busy)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSurface)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.borderStrong, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .padding(.horizontal, 16)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if canDrive, let s = snapshot {
                Menu {
                    Picker("Mode", selection: Binding(
                        get: { CodeMode(rawValue: s.session.mode) },
                        set: { m in
                            guard let m, m.rawValue != s.session.mode else { return }
                            if m == .full {
                                confirmFullAccess = true
                            } else {
                                Task { await act { try await store.api.setMode(agentId: agentId, sessionId: sessionId, mode: m) } }
                            }
                        }
                    )) {
                        ForEach(CodeMode.choices(remoteModes: s.session.remoteModes)) { Text($0.label).tag(Optional($0)) }
                    }
                    if !s.session.remoteModes, let current = CodeMode(rawValue: s.session.mode), current.needsRemoteModes {
                        Text("Now: \(s.session.modeLabel)")
                    }
                    if status == .idle, s.lastTurnId != nil {
                        Button(role: .destructive) { confirmUndo = true } label: {
                            Label("Undo last turn", systemImage: "arrow.uturn.backward")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Session options")
            }
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 6) {
            if let note {
                Text(note)
                    .font(.caption)
                    .foregroundColor(Theme.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if canDrive {
                HStack(spacing: 8) {
                    if status.isActive {
                        Button(role: .destructive) {
                            Task { await act { try await store.api.cancel(agentId: agentId, sessionId: sessionId) } }
                        } label: {
                            Label("Stop", systemImage: "stop.circle")
                        }
                        .buttonStyle(.bordered)
                    } else if snapshot?.lastTurnId != nil {
                        Button {
                            confirmUndo = true
                        } label: {
                            Label("Undo last turn", systemImage: "arrow.uturn.backward")
                        }
                        .buttonStyle(.bordered)
                    }
                    Spacer(minLength: 0)
                    if busy { ProgressView().controlSize(.small) }
                }
                .font(.callout)
                HStack(alignment: .bottom, spacing: 10) {
                    TextField(status.isActive ? "Queue a message…" : "Message your computer…", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...6)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.bgInput)
                        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.borderStrong, lineWidth: 0.5))
                    Button {
                        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            if await act({ try await store.api.send(agentId: agentId, sessionId: sessionId, text: text) }) { draft = "" }
                        }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(sendDisabled ? Theme.textMuted : Theme.accent)
                    }
                    .disabled(sendDisabled)
                    .accessibilityLabel("Send message")
                }
            } else if let m = machine {
                Text(CodeMachineCopy.hint(m) ?? CodeMachineCopy.turnOnHint)
                    .font(.callout)
                    .foregroundColor(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var sendDisabled: Bool {
        busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Loading

    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let s = try await store.api.snapshot(agentId: agentId, sessionId: sessionId)
            if s != snapshot { snapshot = s }
            loadError = nil
        } catch is CancellationError {
        } catch {
            let sentence = (error as? CodeError)?.sentence ?? error.localizedDescription
            if snapshot == nil { loadError = sentence } else { note = sentence }
        }
    }

    /// Re-fetches every ~2.5 s while the session runs or waits (or just after a write), only in the foreground.
    private func poll() async {
        guard scenePhase == .active, status.isActive || kick > 0 else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: Self.pollInterval)
            if Task.isCancelled || scenePhase != .active { return }
            await refresh()
            if kick > 0 { kick = status.isActive ? 0 : kick - 1 }
            if !status.isActive && kick == 0 { return }
        }
    }

    private func loadOlder() async {
        let first = (older + (snapshot?.tail ?? [])).first?.id
        do {
            let page = try await store.api.messages(agentId: agentId, sessionId: sessionId, beforeId: first)
            older = page.items.filter { m in !older.contains { $0.id == m.id } } + older
            moreOlder = page.more
        } catch {
            note = (error as? CodeError)?.sentence ?? error.localizedDescription
        }
    }

    /// Runs one write, then refreshes and keeps polling for a few rounds so the turn shows up.
    @discardableResult
    private func act(_ write: () async throws -> Void) async -> Bool {
        busy = true
        note = nil
        defer { busy = false }
        do {
            try await write()
        } catch {
            note = (error as? CodeError)?.sentence ?? error.localizedDescription
            return false
        }
        await refresh()
        kick = 4
        return true
    }
}

// MARK: - Tool steps

/// A turn's tool calls, collapsed to one line ("3 steps") until tapped.
struct CodeStepsView: View {
    let steps: [CodeToolStep]
    @State var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: icon(step.status))
                            .foregroundColor(color(step.status))
                            .font(.caption)
                            .accessibilityLabel(step.status)
                        Text(step.tool)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundColor(Theme.textSecondary)
                        Text(step.detail)
                            .font(.caption.monospaced())
                            .foregroundColor(Theme.textMuted)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
            }
            .padding(.top, 4)
        } label: {
            Text(summary)
                .font(.caption.weight(.medium))
                .foregroundColor(Theme.textMuted)
        }
        .tint(Theme.textMuted)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bgElevated.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var summary: String {
        let n = steps.count
        let tools = Array(NSOrderedSet(array: steps.map(\.tool))).compactMap { $0 as? String }.prefix(3).joined(separator: ", ")
        return "\(n) step\(n == 1 ? "" : "s") · \(tools)"
    }

    private func icon(_ status: String) -> String {
        switch status {
        case "ok": return "checkmark.circle.fill"
        case "error": return "xmark.octagon.fill"
        case "denied": return "hand.raised.fill"
        case "pending": return "questionmark.circle.fill"
        default: return "circle.dotted"
        }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "ok": return Theme.green
        case "error", "denied": return Theme.red
        case "pending": return Theme.accent
        default: return Theme.textMuted
        }
    }
}

// MARK: - Approval card

/// A tool call waiting for an answer, with the full command or detail.
struct CodeApprovalCard: View {
    let approval: CodeApproval
    let canDrive: Bool
    let busy: Bool
    /// The Mac takes "Allow for this session" (`remoteModes`).
    var remoteModes: Bool = false
    let answer: (Bool) -> Void
    /// "Allow for this session": approves this call and lets later ones of its kind run.
    var allowForSession: (() -> Void)?

    private var offersSession: Bool {
        remoteModes && canDrive && approval.approvable && approval.allowSession != nil && allowForSession != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill").foregroundColor(Theme.accent).accessibilityHidden(true)
                Text(title)
                    .font(.headline)
                    .foregroundColor(Theme.textPrimary)
            }
            // Wrapped, never cut: what is approved is all on screen.
            Text(approval.fullText)
                .font(.callout.monospaced())
                .foregroundColor(Theme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgDeep)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            if approval.command != nil, !approval.detail.isEmpty, approval.detail != approval.command {
                Text(approval.detail).font(.caption).foregroundColor(Theme.textMuted)
            }
            if !approval.approvable {
                Label(approval.message ?? "Approve this on your Mac.", systemImage: "desktopcomputer")
                    .font(.callout)
                    .foregroundColor(Theme.textSecondary)
                if canDrive {
                    Button("Deny", role: .destructive) { answer(false) }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                }
            } else if canDrive {
                HStack(spacing: 10) {
                    Button(role: .destructive) { answer(false) } label: {
                        Text(isCostCheck ? "Stop" : "Deny").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button { answer(true) } label: {
                        Text(isCostCheck ? "Keep going" : "Approve").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                }
                .disabled(busy)
                if offersSession, let caption = approval.allowSessionCaption {
                    VStack(alignment: .leading, spacing: 4) {
                        Button { allowForSession?() } label: {
                            Text("Allow for this session").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(Theme.accent)
                        .disabled(busy)
                        .accessibilityHint(caption)
                        Text(caption)
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityHidden(true)
                    }
                }
            } else {
                Text("Approve or deny this on the computer, or turn on 'Code from your phone' there.")
                    .font(.callout)
                    .foregroundColor(Theme.textSecondary)
            }
        }
        .padding(14)
        .background(Theme.bgSurface)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.accent.opacity(0.6), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var isCostCheck: Bool { approval.tool == "cost_check" }

    private var title: String {
        switch approval.tool {
        case "run_shell": return "Run this command?"
        case "write_file", "edit_file", "apply_patch": return "Change this file?"
        case "git_commit": return "Make this commit?"
        // A Mac chat's per-reply cost check: approve is Keep going, deny is Stop (Switch is on the Mac).
        case "cost_check": return "Keep going?"
        default: return "Allow \(approval.tool)?"
        }
    }
}
