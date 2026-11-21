import SwiftUI

struct ChatView: View {
    @EnvironmentObject private var conversationStore: ConversationStore
    @EnvironmentObject private var chatRouter: ChatRouter
    @EnvironmentObject private var sessionStore: SessionStore

    /// Requests from the drawer and header (ChatTabView): open a chat, start a new one.
    @Binding var command: ChatCommand?
    /// The open chat's id, for the drawer's highlight.
    @Binding var activeConversationId: String?

    @State private var conversation = Conversation(source: .chat)
    @State private var inputText = ""
    @State private var isStreaming = false
    @State private var streamingContent = ""
    @State private var streamProgress: StreamProgress?
    @State private var showModelPicker = false
    @State private var streamStatus = ""
    @EnvironmentObject private var purchasePolicy: PurchasePolicy
    @EnvironmentObject private var networkStatus: NetworkStatusStore
    @Environment(\.openURL) private var openURL
    /// Settings > Chat "Search the web automatically" (on by default).
    @AppStorage(WebSearchPreference.storageKey) private var webAutoDefault = true

    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if conversation.messages.isEmpty && !isStreaming {
                            emptyState
                        }

                        ForEach(conversation.messages) { msg in
                            MessageBubble(
                                message: msg,
                                buyAction: purchaseAction,
                                retryAction: msg.failure != nil || msg.cutShort == true ? { retry(msg) } : nil,
                                signedInLine: signedInLine
                            )
                            .id(msg.id)
                        }

                        if isStreaming {
                            MessageBubble(
                                message: ChatMessage(role: .assistant, content: streamingContent),
                                streaming: true,
                                progress: streamProgress,
                                statusText: streamStatus
                            )
                            .id("streaming")
                        }
                    }
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onTapGesture {
                    inputFocused = false
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
            activeConversationId = conversation.id
        }
        .onChange(of: conversation.id) { _, id in
            activeConversationId = id
        }
        .onChange(of: command) { _, cmd in
            guard let cmd else { return }
            command = nil
            switch cmd {
            case .select(let id): loadConversation(id: id)
            case .newChat: newChat()
            }
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(
                selectedModel: $conversation.selectedModel,
                isPresented: $showModelPicker,
                localModels: chatRouter.modelManager.installedModels,
                localActiveModel: chatRouter.modelManager.selectedModel,
                catalogModels: chatRouter.modelManager.availableCatalog,
                blePeers: chatRouter.bleMeshManager.discoveredPeers,
                isSignedIn: sessionStore.isAuthenticated
            )
        }
    }

    // MARK: - Model picker

    /// The model chip under the message box (was the header's centre button).
    private var modelButton: some View {
        Button {
            showModelPicker = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu").font(.caption2)
                Text(ModelChoice.label(conversation.selectedModel))
                    .font(.caption)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .foregroundColor(Theme.textMuted)
        }
        .accessibilityLabel("Model: \(ModelChoice.label(conversation.selectedModel))")
        .accessibilityHint("Choose the model for this chat")
        .accessibilityIdentifier("modelPicker")
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
            Text(sessionStore.isAuthenticated
                 ? "Replies run on your own machines first (free), then on the EdgeCoder network."
                 : "Sign in to chat on your machines and the EdgeCoder network. Without an account, a model on this iPhone or a nearby device answers.")
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
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message...", text: $inputText, axis: .vertical)
                    .focused($inputFocused)
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
            HStack(spacing: 14) {
                modelButton
                if usesPortal { webMenu }
            }
            .padding(.leading, 6)
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

    /// Web search for this chat (on unless turned off here or in Settings).
    private var webOn: Bool {
        WebSearchPreference.enabled(chatMode: conversation.webMode, defaultOn: webAutoDefault)
    }

    /// The quiet "Web: Auto" indicator under the message box, with Auto / Off for this chat
    /// (src/portal/pages/chat.ts #webMenu).
    private var webMenu: some View {
        Menu {
            Button {
                conversation.webMode = WebSearchPreference.chatMode(on: true, defaultOn: webAutoDefault)
            } label: {
                if webOn { Image(systemName: "checkmark") }
                Text("Auto")
                Text("Searches when a question needs fresh information, and cites sources.")
            }
            Button {
                conversation.webMode = WebSearchPreference.chatMode(on: false, defaultOn: webAutoDefault)
            } label: {
                if !webOn { Image(systemName: "checkmark") }
                Text("Off for this chat")
                Text("Answers from the model alone.")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "globe").font(.caption2)
                Text(webOn ? "Web: Auto" : "Web: Off").font(.caption)
            }
            .foregroundColor(Theme.textMuted)
            .opacity(webOn ? 1 : 0.7)
        }
        .accessibilityLabel(webOn ? "Web: Auto" : "Web: Off")
        .accessibilityHint("Choose whether this chat searches the web")
    }

    // MARK: - Actions

    /// Signed in, and not a model on this phone or a nearby device: the web chat API (Auto: your
    /// own machines first, then the network), as the web and desktop chats do.
    private var usesPortal: Bool {
        guard sessionStore.isAuthenticated else { return false }
        guard let m = conversation.selectedModel else { return true }
        if chatRouter.modelManager.installedModels.contains(where: { $0.modelId == m }) { return false }
        if chatRouter.bleMeshManager.discoveredPeers.contains(where: { $0.model == m }) { return false }
        return true
    }

    private func sendMessage(retrying: String? = nil) {
        let text = (retrying ?? inputText).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isStreaming else { return }

        if retrying == nil { inputText = "" }
        let isRetry = retrying != nil && conversation.messages.last(where: { $0.role == .user })?.content == text
        if !isRetry { conversation.addMessage(role: .user, content: text) }

        isStreaming = true
        streamingContent = ""
        streamProgress = nil
        streamStatus = ""

        Task {
            if usesPortal {
                await sendViaPortal(text, resend: isRetry)
            } else {
                await sendOnDevice()
            }
            conversationStore.save(conversation)
            conversationStore.saveLastId(conversation.id, source: .chat)
            streamingContent = ""
            streamProgress = nil
            streamStatus = ""
            isStreaming = false
        }
    }

    /// Local model, a nearby device, or the offline note (ChatRouter).
    private func sendOnDevice() async {
        let session = chatRouter.routeChatStreaming(
            messages: conversation.messages,
            requestedModel: conversation.selectedModel
        )
        streamProgress = session.getProgress()
        do {
            for try await chunk in session.tokens {
                streamingContent += chunk
                streamProgress = session.getProgress()
            }
            let p = session.getProgress()
            let footer = p.routeLabel.isEmpty ? nil : [p.model.isEmpty ? nil : p.model, p.routeLabel, p.route == .local || p.route == .blePeer ? "free" : nil].compactMap { $0 }.joined(separator: " \u{00B7} ")
            conversation.addMessage(role: .assistant, content: streamingContent, footer: footer)
        } catch {
            conversation.addMessage(role: .assistant, content: "", failure: ChatFailureInfo(message: error.localizedDescription, retryText: lastUserText))
        }
    }

    /// The web chat API: the reply streams in, then its footer (cSats spent and where it ran), or
    /// the shared failure line with Buy cSats / Retry (src/portal/pages/chat.ts).
    private func sendViaPortal(_ text: String, resend: Bool) async {
        let started = Date()
        var failure: ChatFailureInfo?
        var footer: String?
        var gotDone = false
        let web = webOn
        var doneWeb: PortalWebUsage?
        var webOff: (reason: String, message: String)?
        do {
            let convId: String
            if let id = conversation.portalConversationId {
                convId = id
            } else {
                convId = try await PortalChatClient.shared.createConversation(title: String(text.prefix(60)))
                conversation.portalConversationId = convId
            }
            let compute = ModelChoice.compute(for: conversation.selectedModel)
            let routeLabel: String
            switch compute {
            case .auto: routeLabel = "your machines, then the network"
            case .mine: routeLabel = "your machines"
            case .network: routeLabel = "network"
            }
            streamProgress = StreamProgress(route: .swarm, routeLabel: routeLabel)
            for try await event in PortalChatClient.shared.send(conversationId: convId, message: text, compute: compute, resend: resend, web: web) {
                switch event {
                case .content(let c):
                    streamingContent += c
                    streamStatus = ""
                case .status(let s):
                    // "Searching the web…", "Reading example.com…" may come between parts of an answer too.
                    streamStatus = s
                case .web(let w):
                    var p = streamProgress ?? StreamProgress()
                    p.webLine = w.footerLine
                    streamProgress = p
                case .webOff(let reason, let message):
                    webOff = (reason, message)
                case .warning(let w):
                    streamStatus = w
                case .error(let message, let code, let httpStatus):
                    // Once text has arrived, an error finishes the reply (the web chat's rule).
                    if streamingContent.isEmpty && failure == nil {
                        failure = ChatFailureInfo(message: message, code: code, httpStatus: httpStatus, retryText: text)
                    }
                case .done(let cSatsSpent, let computeLabel, let calls, let w):
                    gotDone = true
                    doneWeb = w
                    footer = ServedFormatter.servedLine(calls) ?? ChatFailures.replyFooter(cSatsSpent: cSatsSpent, compute: computeLabel)
                    if (cSatsSpent ?? 0) > 0 { NotificationCenter.default.post(name: .edgeCoderBalanceChanged, object: nil) }
                case .end:
                    break
                }
                var p = streamProgress ?? StreamProgress()
                p.tokenCount += event.isContent ? 1 : 0
                p.elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
                streamProgress = p
            }
        } catch {
            if streamingContent.isEmpty {
                if (error as? APIClientError).map({ if case .serverError("not_authenticated") = $0 { return true } else { return false } }) == true {
                    await sessionStore.refreshSession()
                }
                failure = ChatFailureInfo(message: Self.connectionMessage(error), retryText: text)
            }
        }
        if let failure, streamingContent.isEmpty {
            conversation.addMessage(role: .assistant, content: "", failure: failure)
        } else if streamingContent.isEmpty {
            conversation.addMessage(role: .assistant, content: "", failure: ChatFailureInfo(message: gotDone ? "The model returned an empty reply." : "No reply came back.", retryText: text))
        } else {
            let cut = !gotDone && ChatFailures.looksTruncated(streamingContent)
            conversation.addMessage(role: .assistant, content: streamingContent, footer: footer, cutShort: cut ? true : nil)
            let last = conversation.messages.count - 1
            if let doneWeb {
                let sources = doneWeb.sources.filter { $0.link != nil }
                if !sources.isEmpty { conversation.messages[last].webSources = sources }
                let line = doneWeb.footerLine
                if !line.isEmpty { conversation.messages[last].webFooter = line }
            }
            // No cSats (or the hour's searches used): noted once per chat, quietly, under the reply.
            if web, let webOff, let note = WebSearchPreference.offNote(reason: webOff.reason, message: webOff.message),
               !(conversation.webNotedReasons ?? []).contains(webOff.reason) {
                conversation.messages[last].webNote = note
                conversation.webNotedReasons = (conversation.webNotedReasons ?? []) + [webOff.reason]
            }
        }
    }

    /// A dropped connection in the web chat's words ("Load failed" and friends map to it).
    static func connectionMessage(_ error: Error) -> String {
        if let u = error as? URLError {
            switch u.code {
            case .timedOut: return "No response from EdgeCoder for 120 seconds."
            case .notConnectedToInternet: return "You're offline."
            default: return "The network connection was lost."
            }
        }
        return error.localizedDescription
    }

    private var lastUserText: String? {
        conversation.messages.last(where: { $0.role == .user })?.content
    }

    private func retry(_ message: ChatMessage) {
        guard let text = message.failure?.retryText ?? lastUserText, !isStreaming else { return }
        conversation.messages.removeAll { $0.id == message.id }
        sendMessage(retrying: text)
    }

    /// Buy cSats under an out-of-cSats reply: only where the App Store rules allow (PurchasePolicy).
    private var purchaseAction: (() -> Void)? {
        if purchasePolicy.canLinkOut {
            let url = purchasePolicy.webBuyURL
            return { openURL(url) }
        }
        return nil
    }

    /// "Signed in as you@example.com · 12 cSats" under an out-of-cSats reply (which account is short).
    private var signedInLine: String? {
        guard let email = sessionStore.user?.email else { return nil }
        return "Signed in as \(email)" + (networkStatus.cSats.map { " \u{00B7} " + ChatFailures.formatCSats($0) } ?? "")
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
