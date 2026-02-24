import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var conversationStore: ConversationStore
    @EnvironmentObject private var chatRouter: ChatRouter
    @EnvironmentObject private var sessionStore: SessionStore

    @State private var conversation = Conversation(source: .chat)
    @State private var inputText = ""
    @State private var isStreaming = false
    @State private var streamingContent = ""
    @State private var showHistory = false
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            header

            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if conversation.messages.isEmpty && !isStreaming {
                            emptyState
                        }

                        ForEach(conversation.messages) { msg in
                            MessageBubble(message: msg)
                                .id(msg.id)
                        }

                        if isStreaming && !streamingContent.isEmpty {
                            MessageBubble(
                                message: ChatMessage(role: .assistant, content: streamingContent),
                                streaming: true
                            )
                            .id("streaming")
                        }
                    }
                    .padding(.vertical, 12)
                }
                .onChange(of: conversation.messages.count) { _, _ in
                    scrollToBottom(proxy)
                }
                .onChange(of: streamingContent) { _, _ in
                    scrollToBottom(proxy)
                }
            }

            // Input bar
            inputBar
        }
        .background(Theme.bgBase)
        .onAppear {
            restoreLastConversation()
        }
        .sheet(isPresented: $showHistory) {
            ConversationSidebar(
                source: .chat,
                activeConversationId: conversation.id,
                onSelect: { id in
                    loadConversation(id: id)
                    showHistory = false
                },
                onNewChat: {
                    newChat()
                    showHistory = false
                }
            )
            .environmentObject(conversationStore)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(sessionStore)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Button {
                showSettings = true
            } label: {
                Image(systemName: "person.circle")
                    .font(.title3)
                    .foregroundColor(Theme.textSecondary)
            }

            Spacer()

            Text(conversation.title)
                .font(.headline)
                .foregroundColor(Theme.textPrimary)
                .lineLimit(1)

            Spacer()

            HStack(spacing: 16) {
                Button {
                    newChat()
                } label: {
                    Image(systemName: "plus")
                        .font(.title3)
                        .foregroundColor(Theme.textSecondary)
                }

                Button {
                    showHistory = true
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.title3)
                        .foregroundColor(Theme.textSecondary)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.bgBase)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.border)
                .frame(height: 0.5)
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundColor(Theme.textMuted)
            Text("Start a conversation")
                .font(.headline)
                .foregroundColor(Theme.textSecondary)
            Text("Messages are routed through your local model, nearby peers, or the swarm network.")
                .font(.caption)
                .foregroundColor(Theme.textMuted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
        }
        .frame(minHeight: 300)
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message...", text: $inputText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .foregroundColor(Theme.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.bgInput)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Theme.borderStrong, lineWidth: 0.5)
                )
                .lineLimit(1...6)
                .onSubmit {
                    sendMessage()
                }

            Button {
                sendMessage()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 32))
                    .foregroundColor(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isStreaming ? Theme.textMuted : Theme.accent)
            }
            .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isStreaming)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.bgBase)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Theme.border)
                .frame(height: 0.5)
        }
    }

    // MARK: - Actions

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }

        inputText = ""
        conversation.addMessage(role: .user, content: text)

        isStreaming = true
        streamingContent = ""

        Task {
            let stream = chatRouter.routeChatStreaming(messages: conversation.messages)
            do {
                for try await chunk in stream {
                    streamingContent += chunk
                }
                conversation.addMessage(role: .assistant, content: streamingContent)
                conversationStore.save(conversation)
                conversationStore.saveLastId(conversation.id, source: .chat)
            } catch {
                conversation.addMessage(role: .assistant, content: "Error: \(error.localizedDescription)")
                conversationStore.save(conversation)
            }
            streamingContent = ""
            isStreaming = false
        }
    }

    private func newChat() {
        if !conversation.messages.isEmpty {
            conversationStore.save(conversation)
        }
        conversation = Conversation(source: .chat)
        streamingContent = ""
        isStreaming = false
    }

    private func loadConversation(id: String) {
        if !conversation.messages.isEmpty {
            conversationStore.save(conversation)
        }
        if let loaded = conversationStore.load(id: id) {
            conversation = loaded
            streamingContent = ""
            isStreaming = false
        }
    }

    private func restoreLastConversation() {
        if let lastId = conversationStore.lastId(source: .chat),
           let loaded = conversationStore.load(id: lastId) {
            conversation = loaded
        } else {
            let recent = conversationStore.list(source: .chat)
            if let first = recent.first,
               let loaded = conversationStore.load(id: first.id) {
                conversation = loaded
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            if isStreaming {
                proxy.scrollTo("streaming", anchor: .bottom)
            } else if let last = conversation.messages.last {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }
}
