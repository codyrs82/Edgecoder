import SwiftUI
import UIKit

/// Open/closed state for the side drawer.
///
/// On a compact-width window (every iPhone, an iPad in narrow split-screen) the drawer slides over
/// the content and closes when a row is picked. On a regular-width iPad window it is a persistent
/// sidebar beside the content; the hamburger hides or shows it and picking a row leaves it open.
@MainActor
final class SideDrawerState: ObservableObject {
    /// The overlay drawer (compact width).
    @Published private(set) var isOpen = false
    /// The persistent sidebar is hidden (regular width).
    @Published private(set) var sidebarHidden = false
    /// Regular width: the drawer is a sidebar instead of an overlay. Set by SideDrawer.
    @Published var isPersistent = false

    /// The list is on screen right now, whichever form it takes.
    var isShowing: Bool { isPersistent ? !sidebarHidden : isOpen }

    func open() {
        if isPersistent { sidebarHidden = false } else { isOpen = true }
    }

    func close() {
        if isPersistent { sidebarHidden = true } else { isOpen = false }
    }

    func toggle() {
        isShowing ? close() : open()
    }

    /// A row (or "New") was picked: the overlay closes, the sidebar stays.
    func didSelect() {
        if !isPersistent { isOpen = false }
    }
}

/// A drawer that slides in from the left over `content` (dimmed backdrop; tap it, drag the drawer
/// left, or VoiceOver's escape gesture to close; swipe from the left edge to open). On a
/// regular-width window it shows as a sidebar next to the content instead.
struct SideDrawer<Content: View, Drawer: View>: View {
    @ObservedObject var state: SideDrawerState
    /// Read by VoiceOver when the drawer opens ("Chats").
    var accessibilityName: String
    @ViewBuilder var content: () -> Content
    @ViewBuilder var drawer: () -> Drawer

    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    /// Live drag offset while the drawer is pulled closed (<= 0) or pulled open from the edge (>= 0).
    @GestureState private var dragX: CGFloat = 0

    private var regular: Bool { sizeClass == .regular }
    private var animation: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.88) }

    var body: some View {
        GeometryReader { geo in
            let width = drawerWidth(geo.size.width)
            Group {
                if regular {
                    sidebarLayout(width: width)
                } else {
                    overlayLayout(width: width)
                }
            }
        }
        .onAppear { state.isPersistent = regular }
        .onChange(of: regular) { _, isRegular in
            withAnimation(animation) { state.isPersistent = isRegular }
        }
        .onChange(of: state.isShowing) { _, showing in
            announce(showing)
        }
    }

    private func drawerWidth(_ available: CGFloat) -> CGFloat {
        regular ? min(320, max(260, available * 0.32)) : min(320, available * 0.84)
    }

    // MARK: - Regular width: persistent sidebar

    private func sidebarLayout(width: CGFloat) -> some View {
        HStack(spacing: 0) {
            if state.isShowing {
                drawer()
                    .frame(width: width)
                    .background(Theme.bgSurface)
                    .overlay(alignment: .trailing) {
                        Rectangle().fill(Theme.border).frame(width: 0.5)
                    }
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
            }
            content()
                .frame(maxWidth: .infinity)
        }
        .animation(animation, value: state.isShowing)
    }

    // MARK: - Compact width: overlay

    private func overlayLayout(width: CGFloat) -> some View {
        // Positive = toward the trailing edge in LTR; mirror for RTL so "from the left" stays leading.
        let sign: CGFloat = layoutDirection == .rightToLeft ? -1 : 1
        let open = state.isOpen
        let offset: CGFloat = open ? min(0, dragX) : (dragX > 0 ? min(dragX, width) - width : -width)
        let progress = max(0, min(1, (width + offset) / width))
        let visible = open || dragX > 0

        return ZStack(alignment: .leading) {
            content()
                .accessibilityHidden(open)
                // Swipe from the leading edge to open.
                .overlay(alignment: .leading) {
                    if !open {
                        Color.clear
                            .frame(width: 16)
                            .contentShape(Rectangle())
                            .gesture(edgeOpenGesture(width: width, sign: sign))
                            .accessibilityHidden(true)
                    }
                }

            if visible {
                Color.black
                    .opacity(0.45 * progress)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .gesture(closeGesture(width: width, sign: sign))
                    .accessibilityElement()
                    .accessibilityLabel("Close \(accessibilityName)")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { close() }
                    .transition(.opacity)

                drawer()
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .background(Theme.bgSurface.ignoresSafeArea(edges: .vertical))
                    .overlay(alignment: .trailing) {
                        Rectangle().fill(Theme.border).frame(width: 0.5)
                    }
                    .shadow(color: .black.opacity(0.25 * progress), radius: 12, x: 2)
                    .offset(x: reduceMotion && dragX == 0 ? 0 : offset * sign)
                    .opacity(reduceMotion ? (open ? 1 : progress) : 1)
                    .gesture(closeGesture(width: width, sign: sign))
                    .accessibilityAddTraits(.isModal)
                    .accessibilityAction(.escape) { close() }
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
                    .zIndex(1)
            }
        }
        .animation(animation, value: open)
    }

    private func close() {
        withAnimation(animation) { state.close() }
    }

    private func edgeOpenGesture(width: CGFloat, sign: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($dragX) { value, out, _ in
                out = max(0, value.translation.width * sign)
            }
            .onEnded { value in
                let moved = value.translation.width * sign
                let predicted = value.predictedEndTranslation.width * sign
                if moved > width * 0.35 || predicted > width * 0.6 {
                    withAnimation(animation) { state.open() }
                }
            }
    }

    private func closeGesture(width: CGFloat, sign: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .updating($dragX) { value, out, _ in
                out = min(0, value.translation.width * sign)
            }
            .onEnded { value in
                let moved = value.translation.width * sign
                let predicted = value.predictedEndTranslation.width * sign
                if moved < -width * 0.35 || predicted < -width * 0.6 {
                    withAnimation(animation) { state.close() }
                }
            }
    }

    /// VoiceOver: say the drawer opened and move focus into it (the overlay is modal); say when it
    /// closed. The persistent sidebar only announces.
    private func announce(_ showing: Bool) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        if showing && !state.isPersistent {
            // Give the drawer a moment to appear so focus lands on its first element (the heading).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                UIAccessibility.post(notification: .screenChanged, argument: "\(accessibilityName) opened")
            }
        } else {
            UIAccessibility.post(notification: .announcement, argument: "\(accessibilityName) \(showing ? "shown" : "closed")")
        }
    }
}
