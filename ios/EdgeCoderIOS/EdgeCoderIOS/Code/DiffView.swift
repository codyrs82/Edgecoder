import SwiftUI

/// The files one turn changed, each with a simple unified diff (monospaced, +/- colored, scrolls sideways).
struct DiffView: View {
    let api: CodeAPI
    let agentId: String
    let sessionId: String
    let turnId: String

    @State private var changes: CodeChanges?
    @State private var error: String?

    var body: some View {
        Group {
            if let changes {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        Text(summary(changes))
                            .font(.caption)
                            .foregroundColor(Theme.textMuted)
                            .padding(.horizontal, 16)
                        ForEach(Array(changes.items.enumerated()), id: \.element.id) { i, file in
                            DiffFileView(file: file, expanded: i < 3)
                        }
                    }
                    .padding(.vertical, 12)
                }
            } else if let error {
                CodeErrorBanner(text: error) { Task { await load() } }
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            } else {
                ProgressView("Loading changes…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bgBase)
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func summary(_ c: CodeChanges) -> String {
        let n = c.total
        var s = n == 1 ? "1 file changed in this turn" : "\(n) files changed in this turn"
        if c.truncated || c.items.count < n { s += " (showing \(c.items.count))" }
        return s
    }

    private func load() async {
        do {
            changes = try await api.changes(agentId: agentId, sessionId: sessionId, turnId: turnId)
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = (error as? CodeError)?.sentence ?? error.localizedDescription
        }
    }
}

struct DiffFileView: View {
    let file: CodeFileChange
    @State var expanded: Bool

    private var lines: [UnifiedDiff.Line] { UnifiedDiff.diff(before: file.before, after: file.after) }

    var body: some View {
        let lines = self.lines
        let counts = UnifiedDiff.counts(lines)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundColor(Theme.textMuted)
                        .frame(width: 12)
                    Text(displayPath)
                        .font(.footnote.monospaced().weight(.semibold))
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 4)
                    Text(file.kind)
                        .font(.caption2)
                        .foregroundColor(Theme.textMuted)
                    Text("+\(counts.added)").font(.caption.monospaced()).foregroundColor(Theme.green)
                    Text("-\(counts.removed)").font(.caption.monospaced()).foregroundColor(Theme.red)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(displayPath), \(file.kind), \(counts.added) lines added, \(counts.removed) removed")
            .accessibilityHint(expanded ? "Hides the diff" : "Shows the diff")

            if expanded {
                Rectangle().fill(Theme.border).frame(height: 0.5)
                if lines.isEmpty {
                    Text("No line changes.")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                        .padding(12)
                } else {
                    ScrollView(.horizontal, showsIndicators: true) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(lines) { line in
                                DiffLineView(line: line)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                if file.cut {
                    Text("This file is long; the diff covers its start.")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                        .padding(12)
                }
            }
        }
        .background(Theme.bgSurface)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 12)
    }

    /// "<project>/src/a.ts" shows as "src/a.ts".
    private var displayPath: String {
        file.path.hasPrefix("<project>/") ? String(file.path.dropFirst("<project>/".count)) : file.path
    }
}

struct DiffLineView: View {
    let line: UnifiedDiff.Line

    var body: some View {
        HStack(spacing: 0) {
            if line.kind != .hunk {
                Text(number(line.old)).frame(width: 34, alignment: .trailing).foregroundColor(Theme.textMuted)
                Text(number(line.new)).frame(width: 34, alignment: .trailing).foregroundColor(Theme.textMuted)
                    .padding(.trailing, 8)
            }
            Text(line.rendered.isEmpty ? " " : line.rendered)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, line.kind == .hunk ? 8 : 0)
                .padding(.trailing, 12)
        }
        .font(.system(size: 12, design: .monospaced))
        .foregroundColor(foreground)
        .padding(.vertical, 1)
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .background(background)
    }

    private func number(_ n: Int?) -> String { n.map(String.init) ?? "" }

    private var foreground: Color {
        switch line.kind {
        case .added: return Theme.green
        case .removed: return Theme.red
        case .hunk: return Theme.accentSecondary
        case .context: return Theme.textSecondary
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: return Theme.green.opacity(0.12)
        case .removed: return Theme.red.opacity(0.12)
        case .hunk: return Theme.accentSecondary.opacity(0.08)
        case .context: return .clear
        }
    }
}
