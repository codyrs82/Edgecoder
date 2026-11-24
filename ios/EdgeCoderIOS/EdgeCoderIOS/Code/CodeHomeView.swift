import SwiftUI

/// Where Code mode's navigation stack is.
enum CodeRoute: Hashable {
    case machine(String)
    case session(agentId: String, sessionId: String)
    case diff(agentId: String, sessionId: String, turnId: String)
}

/// Code mode: your computers -> a computer's projects and sessions -> a session (-> a turn's diff).
struct CodeHomeView: View {
    @ObservedObject var store: CodeStore
    @Binding var path: [CodeRoute]
    @Binding var showNewSession: Bool
    /// False when the iPad sidebar beside it already shows the empty-state sentence.
    var showsExplanation = true

    var body: some View {
        NavigationStack(path: $path) {
            CodeMachineListView(store: store, showsExplanation: showsExplanation)
                .navigationDestination(for: CodeRoute.self) { route in
                    switch route {
                    case .machine(let agentId):
                        CodeMachineView(store: store, agentId: agentId, path: $path)
                    case .session(let agentId, let sessionId):
                        CodeSessionView(store: store, agentId: agentId, sessionId: sessionId)
                    case .diff(let agentId, let sessionId, let turnId):
                        DiffView(api: store.api, agentId: agentId, sessionId: sessionId, turnId: turnId)
                    }
                }
        }
        .sheet(isPresented: $showNewSession) {
            NewCodeSessionSheet(store: store, preferredAgent: currentAgent) { agentId, sessionId in
                path = [.machine(agentId), .session(agentId: agentId, sessionId: sessionId)]
            }
        }
    }

    /// The computer on screen (the new-session sheet starts on it).
    private var currentAgent: String? {
        for route in path.reversed() {
            switch route {
            case .machine(let a): return a
            case .session(let a, _): return a
            case .diff(let a, _, _): return a
            }
        }
        return nil
    }
}

// MARK: - Machine list

struct CodeMachineListView: View {
    @ObservedObject var store: CodeStore
    var showsExplanation = true

    var body: some View {
        Group {
            if !store.loaded && store.machines.isEmpty {
                ProgressView("Looking for your computers…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.machines.isEmpty {
                emptyState
            } else {
                List {
                    if let error = store.error {
                        CodeErrorBanner(text: error) { Task { await store.refresh() } }
                            .listRowBackground(Color.clear)
                    }
                    Section {
                        ForEach(store.machines) { m in
                            if m.canRead {
                                NavigationLink(value: CodeRoute.machine(m.agentId)) { CodeMachineRow(machine: m) }
                            } else {
                                CodeMachineRow(machine: m)
                            }
                        }
                    } header: {
                        Text("Your computers")
                    } footer: {
                        Text("Sessions run on the computer; your phone sends messages and approvals.")
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.bgBase)
        .navigationTitle("Code")
        .navigationBarTitleDisplayMode(.inline)
        // The Chat | Code switch above already says where this is.
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await store.refresh() }
        .task { await store.refresh() }
    }

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 12) {
                Image(systemName: "laptopcomputer")
                    .font(.system(size: 40))
                    .foregroundColor(Theme.textMuted)
                    .accessibilityHidden(true)
                Text("No computers yet")
                    .font(.headline)
                    .foregroundColor(Theme.textSecondary)
                if showsExplanation {
                    Text(CodeCopy.emptyState)
                        .font(.callout)
                        .foregroundColor(Theme.textMuted)
                        .multilineTextAlignment(.center)
                }
                if let error = store.error {
                    CodeErrorBanner(text: error) { Task { await store.refresh() } }
                }
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 48)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
    }
}

struct CodeMachineRow: View {
    let machine: CodeMachine

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "laptopcomputer")
                .font(.title3)
                .foregroundColor(machine.canRead ? Theme.accent : Theme.textMuted)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(machine.name)
                        .font(.body.weight(.medium))
                        .foregroundColor(Theme.textPrimary)
                    CodeStatusPill(text: CodeMachineCopy.status(machine), color: color)
                }
                if machine.canRead {
                    Text(summary)
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                }
                if let hint = CodeMachineCopy.hint(machine) {
                    Text(hint)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch machine.availability {
        case .ready: return Theme.green
        case .viewOnly: return Theme.yellow
        case .off, .offline: return Theme.textMuted
        }
    }

    private var summary: String {
        let p = machine.projects.count, s = machine.sessions.count
        let waiting = machine.sessions.reduce(0) { $0 + $1.pendingApprovals }
        var parts = ["\(p) project\(p == 1 ? "" : "s")", "\(s) session\(s == 1 ? "" : "s")"]
        if waiting > 0 { parts.append("\(waiting) waiting for you") }
        return parts.joined(separator: " · ")
    }
}

struct CodeStatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundColor(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14))
            .clipShape(Capsule())
    }
}

struct CodeErrorBanner: View {
    let text: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(Theme.yellow)
                .accessibilityHidden(true)
            Text(text)
                .font(.callout)
                .foregroundColor(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let retry {
                Button("Retry", action: retry)
                    .font(.callout.weight(.semibold))
            }
        }
        .padding(12)
        .background(Theme.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - One computer: its projects and sessions

struct CodeMachineView: View {
    @ObservedObject var store: CodeStore
    let agentId: String
    @Binding var path: [CodeRoute]
    @State private var newSessionProject: CodeProject?

    var body: some View {
        Group {
            if let m = store.machine(agentId) {
                List {
                    if let hint = CodeMachineCopy.hint(m) {
                        CodeErrorBanner(text: hint)
                            .listRowBackground(Color.clear)
                    }
                    if m.projects.isEmpty {
                        Text("No trusted projects on this computer. Open a folder in the EdgeCoder desktop app and trust it.")
                            .font(.callout)
                            .foregroundColor(Theme.textMuted)
                    }
                    ForEach(orderedProjects(m)) { p in
                        Section {
                            let sessions = m.sessions.filter { $0.projectId == p.projectId }.sorted { $0.updatedAtMs > $1.updatedAtMs }
                            ForEach(sessions) { s in
                                NavigationLink(value: CodeRoute.session(agentId: agentId, sessionId: s.sessionId)) {
                                    CodeSessionRow(session: s)
                                }
                            }
                            if m.canDrive {
                                Button {
                                    newSessionProject = p
                                } label: {
                                    Label("New session", systemImage: "plus")
                                        .font(.callout.weight(.medium))
                                }
                            }
                        } header: {
                            CodeProjectHeader(project: p)
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .navigationTitle(m.name)
            } else {
                Text("This computer isn't in your list anymore.")
                    .foregroundColor(Theme.textMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bgBase)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .sheet(item: $newSessionProject) { p in
            NewCodeSessionSheet(store: store, preferredAgent: agentId, preferredProject: p.projectId) { a, s in
                path = [.machine(a), .session(agentId: a, sessionId: s)]
            }
        }
    }

    /// Projects with the newest session first, then the rest by name.
    private func orderedProjects(_ m: CodeMachine) -> [CodeProject] {
        let latest = Dictionary(grouping: m.sessions, by: \.projectId).mapValues { $0.map(\.updatedAtMs).max() ?? 0 }
        return m.projects.sorted { a, b in
            let ta = latest[a.projectId] ?? 0, tb = latest[b.projectId] ?? 0
            return ta != tb ? ta > tb : a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}

struct CodeProjectHeader: View {
    let project: CodeProject

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .accessibilityHidden(true)
            Text(project.name)
                .textCase(nil)
                .font(.subheadline.weight(.semibold))
            if !project.parent.isEmpty {
                Text("in \(project.parent)")
                    .textCase(nil)
                    .font(.caption)
            }
            if let branch = project.branch {
                Label(branch, systemImage: "arrow.triangle.branch")
                    .textCase(nil)
                    .font(.caption)
                    .lineLimit(1)
            }
        }
        .foregroundColor(Theme.textSecondary)
    }
}

struct CodeSessionRow: View {
    let session: CodeSessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(session.title)
                .font(.body)
                .foregroundColor(Theme.textPrimary)
                .lineLimit(2)
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
                Text(session.statusLine)
                if session.updatedAtMs > 0 {
                    Text("·")
                    Text(session.updatedAt.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))
                }
                if let mode = session.modeLabel {
                    Text("·")
                    Text(mode).lineLimit(1).accessibilityLabel("Mode: \(mode)")
                }
                if session.startedFrom == "phone" {
                    Image(systemName: "iphone").accessibilityLabel("Started from your phone")
                }
            }
            .font(.caption)
            .foregroundColor(Theme.textMuted)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch session.status {
        case .running: return Theme.green
        case .waiting: return Theme.accent
        case .idle: return Theme.textMuted
        }
    }
}

// MARK: - New session

struct NewCodeSessionSheet: View {
    @ObservedObject var store: CodeStore
    var preferredAgent: String?
    var preferredProject: String?
    let onCreated: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var agentId = ""
    @State private var projectId = ""
    @State private var mode: CodeMode = .ask
    @State private var title = ""
    @State private var text = ""
    @State private var working = false
    @State private var error: String?
    /// Created but its first message didn't go through: Start again only resends the message.
    @State private var created: (agentId: String, sessionId: String)?

    private var machines: [CodeMachine] { store.machines.filter(\.canDrive) }
    private var machine: CodeMachine? { machines.first { $0.agentId == agentId } }
    private var canStart: Bool {
        !working && machine?.project(projectId) != nil && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                if machines.isEmpty {
                    Section {
                        Text("None of your computers can take a session from the phone right now. \(CodeMachineCopy.turnOnHint)")
                            .foregroundColor(Theme.textSecondary)
                    }
                } else {
                    Section("Where") {
                        if machines.count > 1 {
                            Picker("Computer", selection: $agentId) {
                                ForEach(machines) { Text($0.name).tag($0.agentId) }
                            }
                        }
                        Picker("Project", selection: $projectId) {
                            ForEach(machine?.projects ?? []) { p in
                                Text(p.parent.isEmpty ? p.name : "\(p.name) (\(p.parent))").tag(p.projectId)
                            }
                        }
                    }
                    Section {
                        Picker("Mode", selection: $mode) {
                            ForEach(CodeMode.basic) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    } header: {
                        Text("Mode")
                    } footer: {
                        Text(mode.explanation + " Auto and Full access can be turned on from the session once it starts, on an up-to-date Mac.")
                    }
                    Section("First message") {
                        TextField("What should it do?", text: $text, axis: .vertical)
                            .lineLimit(3...8)
                        TextField("Title (optional)", text: $title)
                    }
                    if let error {
                        Section { Text(error).foregroundColor(Theme.red) }
                    }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .disabled(!canStart)
                    }
                }
            }
            .onAppear(perform: pickDefaults)
            .onChange(of: agentId) { _, _ in
                if machine?.project(projectId) == nil { projectId = machine?.projects.first?.projectId ?? "" }
            }
        }
    }

    private func pickDefaults() {
        guard agentId.isEmpty else { return }
        agentId = machines.first { $0.agentId == preferredAgent }?.agentId ?? machines.first?.agentId ?? ""
        projectId = machine?.project(preferredProject ?? "")?.projectId
            ?? machine?.sessions.max { $0.updatedAtMs < $1.updatedAtMs }.flatMap { machine?.project($0.projectId) }?.projectId
            ?? machine?.projects.first?.projectId ?? ""
    }

    private func start() async {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        working = true
        error = nil
        defer { working = false }
        do {
            let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let sessionId: String
            if let created, created.agentId == agentId {
                sessionId = created.sessionId
            } else {
                sessionId = try await store.api.create(agentId: agentId, projectId: projectId, title: t.isEmpty ? String(message.prefix(60)) : t, mode: mode)
                created = (agentId, sessionId)
            }
            try await store.api.send(agentId: agentId, sessionId: sessionId, text: message)
            store.refreshInBackground()
            dismiss()
            onCreated(agentId, sessionId)
        } catch {
            self.error = (error as? CodeError)?.sentence ?? error.localizedDescription
        }
    }
}
