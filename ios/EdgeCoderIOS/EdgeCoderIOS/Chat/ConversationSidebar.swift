import SwiftUI

struct ConversationSidebar: View {
    @EnvironmentObject private var store: ConversationStore

    let source: Conversation.Source
    let activeConversationId: String
    let onSelect: (String) -> Void
    let onNewChat: () -> Void

    @State private var searchQuery = ""
    @State private var conversations: [Conversation] = []

    private var filtered: [Conversation] {
        if searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return conversations
        }
        let q = searchQuery.lowercased()
        return conversations.filter {
            $0.title.lowercased().contains(q) ||
            $0.messages.contains { $0.content.lowercased().contains(q) }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // New Chat button
                Button {
                    onNewChat()
                } label: {
                    HStack {
                        Image(systemName: "plus")
                        Text("New Chat")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundColor(Theme.accent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.bgElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(Theme.borderStrong, lineWidth: 0.5)
                    )
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)

                // Search
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                    TextField("Search conversations...", text: $searchQuery)
                        .font(.subheadline)
                        .foregroundColor(Theme.textPrimary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.bgInput)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.top, 12)

                // List
                if filtered.isEmpty {
                    VStack(spacing: 8) {
                        Spacer()
                        Text(searchQuery.isEmpty ? "No conversations yet" : "No results for \"\(searchQuery)\"")
                            .font(.subheadline)
                            .foregroundColor(Theme.textMuted)
                        Spacer()
                    }
                } else {
                    List {
                        ForEach(filtered) { convo in
                            Button {
                                onSelect(convo.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(convo.title)
                                            .font(.subheadline.weight(.medium))
                                            .foregroundColor(Theme.textPrimary)
                                            .lineLimit(1)
                                        Spacer()
                                        if convo.id == activeConversationId {
                                            Circle()
                                                .fill(Theme.accent)
                                                .frame(width: 6, height: 6)
                                        }
                                    }
                                    HStack(spacing: 6) {
                                        Text(formatRelativeTime(convo.updatedAt))
                                            .font(.caption)
                                            .foregroundColor(Theme.textMuted)
                                        if let first = convo.messages.first {
                                            Text("\u{00b7}")
                                                .foregroundColor(Theme.textMuted)
                                            Text(first.content.prefix(50))
                                                .font(.caption)
                                                .foregroundColor(Theme.textSecondary)
                                                .lineLimit(1)
                                        }
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) {
                                    store.delete(id: convo.id)
                                    conversations.removeAll { $0.id == convo.id }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .listRowBackground(
                                convo.id == activeConversationId
                                    ? Theme.accent.opacity(0.08)
                                    : Color.clear
                            )
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bgSurface)
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        // Dismiss handled by parent sheet
                    }
                }
            }
        }
        .onAppear {
            conversations = store.list(source: source)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func formatRelativeTime(_ date: Date) -> String {
        let diff = Date().timeIntervalSince(date)
        let seconds = Int(diff)
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
