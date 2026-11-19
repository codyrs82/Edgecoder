import SwiftUI

/// The side drawer's content: a heading, a "New" button, search, and the source's rows in
/// sections. Works with any DrawerDataSource (local chats, code sessions).
struct ConversationSidebar<Source: DrawerDataSource, Footer: View>: View {
    @ObservedObject var source: Source
    let onSelect: (String) -> Void
    let onNew: () -> Void
    @ViewBuilder var footer: () -> Footer

    @State private var searchQuery = ""
    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        let sections = source.sections(matching: searchQuery)
        let hasAnything = !source.sections(matching: "").isEmpty

        VStack(alignment: .leading, spacing: 0) {
            Text(source.title)
                .font(.title3.weight(.semibold))
                .foregroundColor(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($headingFocused)
                .padding(.horizontal, 16)
                .padding(.top, 14)

            if let newLabel = source.newLabel {
                Button(action: onNew) {
                    Label(newLabel, systemImage: "square.and.pencil")
                        .font(.subheadline.weight(.semibold))
                        .foregroundColor(Theme.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Theme.bgElevated)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Theme.borderStrong, lineWidth: 0.5)
                        )
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }

            if hasAnything {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                        .accessibilityHidden(true)
                    TextField(source.searchPrompt, text: $searchQuery)
                        .font(.subheadline)
                        .foregroundColor(Theme.textPrimary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                    if !searchQuery.isEmpty {
                        Button { searchQuery = "" } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Theme.textMuted)
                        }
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.bgInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }

            if !hasAnything {
                emptyView(title: source.emptyTitle, message: source.emptyMessage)
            } else if sections.isEmpty {
                emptyView(title: "No results for \u{201C}\(searchQuery)\u{201D}", message: nil)
            } else {
                List {
                    ForEach(sections) { section in
                        Section {
                            ForEach(section.rows) { row in
                                rowView(row)
                            }
                        } header: {
                            Text(section.title)
                                .font(.caption.weight(.semibold))
                                .foregroundColor(Theme.textMuted)
                                .textCase(nil)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.immediately)
            }

            footer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.bgSurface)
        .onAppear {
            source.reload()
            if UIAccessibility.isVoiceOverRunning { headingFocused = true }
        }
    }

    private func emptyView(title: String, message: String?) -> some View {
        VStack(spacing: 8) {
            Spacer(minLength: 24)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundColor(Theme.textSecondary)
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundColor(Theme.textMuted)
            }
            Spacer(minLength: 24)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func rowView(_ row: DrawerRow) -> some View {
        let isActive = row.id == source.selectedId
        let button = Button {
            onSelect(row.id)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(row.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    if let date = row.date {
                        Text(Self.relativeTime(date))
                            .font(.caption2)
                            .foregroundColor(Theme.textMuted)
                    }
                }
                if let subtitle = row.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .listRowBackground(isActive ? Theme.accent.opacity(0.10) : Color.clear)

        if source.canDelete {
            button.swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    source.delete(id: row.id)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        } else {
            button
        }
    }

    static func relativeTime(_ date: Date, now: Date = Date()) -> String {
        let seconds = Int(now.timeIntervalSince(date))
        let minutes = seconds / 60
        let hours = minutes / 60
        let days = hours / 24
        if seconds < 60 { return "Just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        if hours < 24 { return "\(hours)h ago" }
        if days == 1 { return "Yesterday" }
        if days < 7 { return "\(days)d ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
