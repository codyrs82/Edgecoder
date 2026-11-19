import SwiftUI

/// What the drawer or header asks the chat screen to do.
enum ChatCommand: Equatable {
    case select(String)
    case newChat
}

/// The first tab ("Chat"): a Chat | Code switch, a hamburger that opens the side drawer (chats or
/// code sessions), and the screen for the chosen mode.
struct ChatTabView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @EnvironmentObject private var networkStatus: NetworkStatusStore

    @AppStorage(WorkspaceMode.storageKey) private var mode: WorkspaceMode = WorkspaceMode.defaultValue
    @StateObject private var drawer = SideDrawerState()
    @StateObject private var chatSource: ChatDrawerSource
    @StateObject private var codeSource = CodeDrawerSource()
    @State private var chatCommand: ChatCommand?
    @State private var activeChatId: String?
    @State private var showSettings = false
    @AccessibilityFocusState private var menuButtonFocused: Bool

    init(conversationStore: ConversationStore) {
        _chatSource = StateObject(wrappedValue: ChatDrawerSource(store: conversationStore))
    }

    var body: some View {
        SideDrawer(state: drawer, accessibilityName: mode == .chat ? "Chats" : "Code sessions") {
            VStack(spacing: 0) {
                header
                switch mode {
                case .chat:
                    ChatView(command: $chatCommand, activeConversationId: $activeChatId)
                case .code:
                    CodePlaceholderView()
                }
            }
            .background(Theme.bgBase)
        } drawer: {
            drawerContent
        }
        .background(Theme.bgBase)
        .onAppear {
            #if DEBUG
            // Screenshots: -drawerOpen starts with the drawer out, -drawerHidden with the iPad sidebar hidden.
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-drawerOpen") { drawer.open() }
            if args.contains("-drawerHidden") { DispatchQueue.main.async { drawer.close() } }
            #endif
        }
        .onChange(of: activeChatId) { _, id in chatSource.selectedId = id }
        .onChange(of: drawer.isShowing) { _, showing in
            // Back to the menu button when the overlay closes, so VoiceOver doesn't lose its place.
            if !showing && !drawer.isPersistent && UIAccessibility.isVoiceOverRunning { menuButtonFocused = true }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .environmentObject(sessionStore)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                drawer.toggle()
            } label: {
                Image(systemName: drawer.isPersistent ? "sidebar.leading" : "line.3.horizontal")
                    .font(.title3)
                    .foregroundColor(Theme.textSecondary)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(mode == .chat ? "Chats" : "Code sessions")
            .accessibilityHint(drawer.isShowing ? "Hides the list" : "Shows the list")
            .accessibilityFocused($menuButtonFocused)
            .accessibilityIdentifier("drawerButton")

            Spacer(minLength: 0)

            Picker("Mode", selection: $mode) {
                ForEach(WorkspaceMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)
            .accessibilityIdentifier("modeSwitch")

            Spacer(minLength: 0)

            HStack(spacing: 8) {
                NetworkBadge(network: networkStatus.network, compact: true)
                Button {
                    chatCommand = .newChat
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.title3)
                        .foregroundColor(Theme.textSecondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("New chat")
                .opacity(mode == .chat ? 1 : 0)
                .disabled(mode != .chat)
                .accessibilityHidden(mode != .chat)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(Theme.bgBase)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
        }
    }

    // MARK: - Drawer

    @ViewBuilder
    private var drawerContent: some View {
        switch mode {
        case .chat:
            ConversationSidebar(
                source: chatSource,
                onSelect: { id in
                    chatCommand = .select(id)
                    drawer.didSelect()
                },
                onNew: {
                    chatCommand = .newChat
                    drawer.didSelect()
                },
                footer: { drawerFooter }
            )
        case .code:
            ConversationSidebar(
                source: codeSource,
                onSelect: { _ in drawer.didSelect() },
                onNew: { drawer.didSelect() },
                footer: { drawerFooter }
            )
        }
    }

    /// Settings (and who is signed in) at the bottom of the drawer, where the old header's person
    /// button used to lead.
    private var drawerFooter: some View {
        Button {
            showSettings = true
            drawer.didSelect()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "person.circle")
                    .font(.title3)
                    .foregroundColor(Theme.textSecondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Settings")
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(Theme.textPrimary)
                    Text(sessionStore.user?.email ?? "Not signed in")
                        .font(.caption)
                        .foregroundColor(Theme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.border).frame(height: 0.5)
        }
        .accessibilityIdentifier("drawerSettings")
    }
}
