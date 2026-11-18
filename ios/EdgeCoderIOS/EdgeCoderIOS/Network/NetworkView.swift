import SwiftUI

/// The Network tab: every coordinator and machine on the EdgeCoder network as the hub-and-spoke graph
/// of the web's and desktop's Settings > Network (GET /portal/api/network/world). Other people's
/// machines are unlabeled dots; yours are named and ringed in the accent colour. Polls every 5 s while
/// the tab is on screen and the app is active.
struct NetworkView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = NetworkViewModel()

    var body: some View {
        NavigationStack {
            content
                .background(Theme.bgBase.ignoresSafeArea())
                .navigationTitle("Network")
                .navigationBarTitleDisplayMode(.inline)
        }
        // Cancelled when the tab is hidden, the app leaves the foreground or the account signs out.
        .task(id: pollKey) {
            guard pollKey.active else { return }
            await model.poll()
        }
    }

    private struct PollKey: Equatable {
        let active: Bool
        let signedIn: Bool
    }

    private var signedIn: Bool { sessionStore.isAuthenticated || NetworkFixture.isEnabled }

    private var pollKey: PollKey {
        PollKey(active: scenePhase == .active && signedIn, signedIn: signedIn)
    }

    @ViewBuilder private var content: some View {
        if !signedIn {
            NetworkMessage(title: "Sign in to see the network",
                           detail: "The network's coordinators and machines, with yours named, show here once you sign in.",
                           identifier: "networkSignedOut")
        } else if let world = model.world {
            if world.coordinators.isEmpty {
                NetworkMessage(title: "No coordinators online",
                               detail: "The network has no coordinator to show right now. This refreshes every few seconds.",
                               identifier: "networkEmpty")
            } else {
                NetworkGraphScreen(world: world, refreshError: model.error)
            }
        } else if let error = model.error {
            VStack(spacing: 12) {
                NetworkMessage(title: "Couldn't load the network", detail: error, identifier: "networkError")
                Button("Try again") { Task { await model.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
        } else {
            ProgressView("Loading the network…")
                .foregroundColor(Theme.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("networkLoading")
        }
    }
}

private struct NetworkMessage: View {
    let title: String
    let detail: String
    let identifier: String

    var body: some View {
        VStack(spacing: 6) {
            Text(title).font(.headline).foregroundColor(Theme.textPrimary)
            Text(detail).font(.footnote).foregroundColor(Theme.textSecondary).multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Loading

@MainActor
final class NetworkViewModel: ObservableObject {
    @Published var world: NetworkWorld?
    @Published var error: String?

    static let pollSeconds: UInt64 = 5

    func poll() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(nanoseconds: Self.pollSeconds * 1_000_000_000)
        }
    }

    func load() async {
        if NetworkFixture.isEnabled {
            world = NetworkFixture.world
            error = nil
            return
        }
        do {
            let (status, data) = try await APIClient.shared.requestRaw(baseURL: APIClient.shared.config.portalBaseURL,
                                                                        path: "/portal/api/network/world")
            if Task.isCancelled { return }
            switch status {
            case 200:
                world = try JSONDecoder().decode(NetworkWorld.self, from: data)
                error = nil
            case 401:
                world = nil
                error = "Your session has ended. Sign in again to see the network."
            case 429:
                // Keep the last view; the next poll tries again.
                error = world == nil ? "The network is busy. Trying again in a few seconds." : nil
            default:
                error = "No coordinator answered. Trying again in a few seconds."
            }
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            self.error = "Couldn't reach EdgeCoder: \(error.localizedDescription)"
        }
    }
}

// MARK: - The graph screen

private enum Selection: Identifiable, Equatable {
    case hub(String)
    case machine(String)
    var id: String {
        switch self {
        case .hub(let id): return "hub:" + id
        case .machine(let id): return "machine:" + id
        }
    }
}

private struct NetworkGraphScreen: View {
    let world: NetworkWorld
    let refreshError: String?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var zoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero
    @State private var selection: Selection?

    var body: some View {
        VStack(spacing: 0) {
            header
            GeometryReader { geo in
                let pad = GraphTransform.labelPad(world)
                let layout = NetworkGraph.layout(world, columns: NetworkGraph.fitColumns(coordinators: world.coordinators.count,
                                                                                         width: geo.size.width - 2 * pad,
                                                                                         height: geo.size.height))
                let lanes = NetworkGraph.pulseLanes(world, layout: layout)
                let path = NetworkGraph.yourPath(world)
                let view = GraphTransform(layout: layout, size: geo.size, labelPad: pad, zoom: zoom * pinch,
                                          pan: CGSize(width: pan.width + drag.width, height: pan.height + drag.height))
                let animate = !reduceMotion && lanes.contains { $0.count > 0 || $0.heartbeat }
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animate)) { timeline in
                    Canvas { ctx, _ in
                        GraphPainter(layout: layout, lanes: lanes, path: path, transform: view, selection: selection,
                                     clockMs: animate ? timeline.date.timeIntervalSince1970 * 1000 : nil)
                            .draw(in: &ctx)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    SimultaneousGesture(
                        MagnificationGesture()
                            .updating($pinch) { value, state, _ in state = value }
                            .onEnded { value in zoom = min(6, max(0.6, zoom * value)) },
                        DragGesture(minimumDistance: 4)
                            .updating($drag) { value, state, _ in state = value.translation }
                            .onEnded { value in
                                pan.width += value.translation.width
                                pan.height += value.translation.height
                            }
                    )
                )
                .onTapGesture { point in
                    selection = view.hit(point)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(accessibilitySummary)
                .accessibilityIdentifier("networkGraph")
            }
            legend
        }
        .toolbar {
            if zoom != 1 || pan != .zero {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Reset") {
                        withAnimation(.easeOut(duration: 0.2)) {
                            zoom = 1
                            pan = .zero
                        }
                    }
                }
            }
        }
        .sheet(item: $selection) { sel in
            NetworkDetailSheet(world: world, selection: sel)
                .presentationDetents([.medium])
        }
    }

    private var header: some View {
        VStack(spacing: 2) {
            Text(NetworkText.summary(world))
                .font(.subheadline.weight(.semibold))
                .foregroundColor(Theme.textPrimary)
                .accessibilityIdentifier("networkSummary")
            if let refreshError {
                Text(refreshError).font(.caption2).foregroundColor(Theme.textMuted)
            } else if world.truncated {
                Text("Showing part of the network").font(.caption2).foregroundColor(Theme.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .padding(.horizontal, 16)
    }

    private var legend: some View {
        let items: [(LegendMark, String)] = [
            (.dot(Theme.green), "Idle"),
            (.dot(Theme.yellow), "Busy"),
            (.dot(Theme.textMuted), "Not seen lately"),
            (.ring(Theme.accent), "Yours"),
            (.pulse, reduceMotion ? "Thicker line: more calls" : "Moving dots: calls in flight"),
            (.path, "Your request"),
        ]
        return FlowRow(spacing: 12, lineSpacing: 4) {
            ForEach(items.indices, id: \.self) { i in
                HStack(spacing: 5) {
                    items[i].0
                    Text(items[i].1).font(.caption2).foregroundColor(Theme.textSecondary)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityHidden(true)
    }

    private var accessibilitySummary: String {
        let busy = world.agents.filter { NetworkGraph.activityOf($0).callsNow > 0 }.count
        let mine = world.agents.filter(\.mine).count
        var parts = ["Network graph: " + NetworkText.summary(world)]
        parts.append(busy == 0 ? "No machines busy" : NetworkText.plural(busy, "machine") + " busy")
        if mine > 0 { parts.append(NetworkText.plural(mine, "machine") + " of yours") }
        if !world.yourRequests.isEmpty { parts.append(NetworkText.plural(world.yourRequests.count, "request") + " of yours in flight") }
        return parts.joined(separator: ". ") + "."
    }
}

private enum LegendMark: View {
    case dot(Color), ring(Color), pulse, path
    var body: some View {
        switch self {
        case .dot(let c): Circle().fill(c).frame(width: 8, height: 8)
        case .ring(let c): Circle().strokeBorder(c, lineWidth: 2).frame(width: 9, height: 9)
        case .pulse: Circle().fill(Theme.accentSecondary).frame(width: 6, height: 6)
        case .path: RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 14, height: 3)
        }
    }
}

/// Wraps its children onto as many lines as they need.
private struct FlowRow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + lineSpacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            line = max(line, size.height)
        }
        return CGSize(width: min(width, widest), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + lineSpacing
                x = bounds.minX
                line = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

// MARK: - Drawing

/// Layout units to screen points: fit the whole map, then the user's zoom and pan.
private struct GraphTransform {
    let layout: WorldLayout
    let scale: CGFloat
    let origin: CGPoint

    /// Room kept on the left and right for your machines' names, which are drawn at a fixed size
    /// beside their dots and would otherwise run off the edge (widest name plus its gap, at most 160).
    static func labelPad(_ world: NetworkWorld) -> CGFloat {
        let font = UIFont.systemFont(ofSize: 11, weight: .semibold)
        let widest = world.agents.filter(\.mine).map { a -> CGFloat in
            let name = NetworkText.shortMachineName(a.name ?? "")
            return (name as NSString).size(withAttributes: [.font: font]).width
        }.max()
        guard let widest else { return 8 }
        return min(160, widest + 20)
    }

    init(layout: WorldLayout, size: CGSize, labelPad: CGFloat = 0, zoom: CGFloat, pan: CGSize) {
        self.layout = layout
        let fit = min(max(1, size.width - 2 * labelPad) / CGFloat(layout.width), size.height / CGFloat(layout.height)) * 0.96
        scale = max(0.01, fit * zoom)
        origin = CGPoint(x: size.width / 2 - CGFloat(layout.width) * scale / 2 + pan.width,
                         y: size.height / 2 - CGFloat(layout.height) * scale / 2 + pan.height)
    }

    func point(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: origin.x + CGFloat(x) * scale, y: origin.y + CGFloat(y) * scale)
    }

    func hubRadius() -> CGFloat { max(13, CGFloat(NetworkGraph.hubR) * scale) }
    func nodeRadius(_ r: Double) -> CGFloat { max(3, CGFloat(r) * scale) }

    /// The node under a tap: a hub first, then the nearest machine within reach.
    func hit(_ p: CGPoint) -> Selection? {
        for h in layout.hubs {
            let c = point(h.x, h.y)
            if hypot(c.x - p.x, c.y - p.y) <= hubRadius() + 4 { return .hub(h.id) }
        }
        var best: (String, CGFloat)?
        for n in layout.machines {
            let c = point(n.x, n.y)
            let d = hypot(c.x - p.x, c.y - p.y)
            if d <= max(nodeRadius(n.r) + 6, 18), d < (best?.1 ?? .infinity) { best = (n.id, d) }
        }
        return best.map { .machine($0.0) }
    }
}

private struct GraphPainter {
    let layout: WorldLayout
    let lanes: [PulseLane]
    let path: (machines: Set<String>, coordinators: Set<String>)
    let transform: GraphTransform
    let selection: Selection?
    /// nil: Reduce Motion (or nothing moving): no dots, the lines' thickness shows the activity.
    let clockMs: Double?

    func draw(in ctx: inout GraphicsContext) {
        let t = transform
        var hubs: [String: HubNode] = [:]
        for h in layout.hubs { hubs[h.id] = h }
        var laneById: [String: PulseLane] = [:]
        for l in lanes { laneById[l.id] = l }

        // Guide rings (20 ms and 100 ms around each coordinator).
        for ring in layout.rings {
            guard let hub = hubs[ring.hubId] else { continue }
            let c = t.point(hub.x, hub.y), r = CGFloat(ring.r) * t.scale
            ctx.stroke(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                       with: .color(Theme.border), style: StrokeStyle(lineWidth: 1, dash: [2, 4]))
            if t.scale > 0.6 {
                ctx.draw(Text("\(ring.ms) ms").font(.system(size: 9)).foregroundColor(Theme.textMuted),
                         at: CGPoint(x: c.x + 4, y: c.y - r - 3), anchor: .bottomLeading)
            }
        }

        // Text placed so far; the coordinator hosts skip themselves rather than draw over any of it.
        var rttLabels: [(text: GraphicsContext.ResolvedText, rect: CGRect)] = []
        var taken: [CGRect] = []

        // Coordinator-to-coordinator mesh links.
        for link in layout.links {
            guard let a = hubs[link.from], let b = hubs[link.to] else { continue }
            let lane = laneById["mesh:" + [link.from, link.to].sorted().joined(separator: "|")]
            let level = lane?.level ?? 0
            var line = Path()
            line.move(to: t.point(a.x, a.y))
            line.addLine(to: t.point(b.x, b.y))
            let width: CGFloat = [2.5, 3, 3.75, 4.5][min(3, level)]
            let opacity: Double = [0.7, 0.8, 0.9, 1][min(3, level)]
            ctx.stroke(line, with: .color(Theme.accentSecondary.opacity(opacity)), lineWidth: width)
            if let clockMs, let lane, lane.heartbeat {
                let phase = (clockMs.truncatingRemainder(dividingBy: NetworkGraph.heartbeatMs)) / NetworkGraph.heartbeatMs
                let breath = phase < 0.08 ? phase / 0.08 * 0.5 : phase < 0.22 ? (0.22 - phase) / 0.14 * 0.5 : 0
                if breath > 0 { ctx.stroke(line, with: .color(Theme.accentSecondary.opacity(breath)), style: StrokeStyle(lineWidth: 5, lineCap: .round)) }
            }
            if let ms = link.rttMs, t.scale > 0.5 {
                // Drawn last, on a chip, so lines, dots and hubs never run through the number.
                let mid = t.point((a.x + b.x) / 2, (a.y + b.y) / 2)
                let text = ctx.resolve(Text(NetworkText.formatMs(ms)).font(.system(size: 10)).foregroundColor(Theme.textSecondary))
                let size = text.measure(in: CGSize(width: 200, height: 40))
                let chip = CGRect(x: mid.x - size.width / 2 - 4, y: mid.y - size.height / 2 - 2,
                                  width: size.width + 8, height: size.height + 4)
                rttLabels.append((text, chip))
            }
        }

        // Spokes: each machine to its coordinator, thicker and blue while it runs calls, orange for yours.
        for n in layout.machines {
            guard let hub = hubs[n.hubId] else { continue }
            var line = Path()
            line.move(to: t.point(hub.x, hub.y))
            line.addLine(to: t.point(n.x, n.y))
            let lane = laneById["spoke:" + n.id]
            if lane?.yours == true {
                ctx.stroke(line, with: .color(Theme.accent), lineWidth: 2.5)
            } else if let lane, lane.level > 0 {
                let w: CGFloat = [1, 1.5, 2.25, 3][lane.level]
                let o: Double = [1, 0.5, 0.65, 0.8][lane.level]
                ctx.stroke(line, with: .color(Theme.accentSecondary.opacity(o)), lineWidth: w)
            } else {
                ctx.stroke(line, with: .color(Theme.borderStrong), lineWidth: 1)
            }
        }

        // Pulses: dots travelling along the busy lines.
        if let clockMs {
            for lane in lanes where lane.count > 0 {
                for i in 0..<lane.count {
                    let (p, reversed) = NetworkGraph.pulseProgress(lane, index: i, clockMs: clockMs)
                    let f = reversed ? 1 - p : p
                    let x = lane.x1 + (lane.x2 - lane.x1) * f, y = lane.y1 + (lane.y2 - lane.y1) * f
                    let c = t.point(x, y)
                    let r: CGFloat = lane.kind == .mesh ? 3.5 : 2.8
                    let fade = min(1, p * 8, (1 - p) * 8)
                    let color = lane.yours ? Theme.accent : Theme.accentSecondary
                    let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
                    ctx.fill(Path(ellipseIn: rect), with: .color(color.opacity(fade * (lane.faint ? 0.45 : 1))))
                    ctx.stroke(Path(ellipseIn: rect), with: .color(Theme.bgSurface.opacity(fade)), lineWidth: 1)
                }
            }
        }

        // Coordinators: blue hubs (grey when unreachable) with their region; orange ring while your request is on one.
        for h in layout.hubs {
            let c = t.point(h.x, h.y), r = t.hubRadius()
            let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
            if path.coordinators.contains(h.id) {
                let rr = r + 5
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: 2 * rr, height: 2 * rr)),
                           with: .color(Theme.accent), style: StrokeStyle(lineWidth: 2, dash: [3, 2]))
            }
            ctx.fill(Path(ellipseIn: rect), with: .color(h.coordinator.reachable ? Theme.accentSecondary : Theme.textMuted))
            ctx.stroke(Path(ellipseIn: rect), with: .color(selection == .hub(h.id) ? Theme.textPrimary : Theme.bgSurface), lineWidth: 3)
            ctx.draw(Text(NetworkText.hubRegion(h.coordinator)).font(.system(size: max(9, min(13, r * 0.46)), weight: .bold))
                        .foregroundColor(Theme.onAccent), at: c, anchor: .center)
        }

        // Machines: green idle, yellow busy, grey not seen lately; yours ringed in orange.
        for n in layout.machines {
            let a = n.machine
            let c = t.point(n.x, n.y), r = t.nodeRadius(n.r)
            let rect = CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)
            let fill: Color = a.status == .idle ? Theme.green : a.status == .busy ? Theme.yellow : Theme.textMuted
            ctx.fill(Path(ellipseIn: rect), with: .color(fill))
            ctx.stroke(Path(ellipseIn: rect), with: .color(selection == .machine(n.id) ? Theme.textPrimary : Theme.bgSurface),
                       lineWidth: selection == .machine(n.id) ? 3 : 1.5)
            if a.mine {
                let rr = r + max(3, 4 * t.scale)
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: 2 * rr, height: 2 * rr)), with: .color(Theme.accent), lineWidth: 2)
            }
            if path.machines.contains(n.id) {
                let rr = r + max(6, (a.mine ? 8 : 5) * t.scale)
                ctx.stroke(Path(ellipseIn: CGRect(x: c.x - rr, y: c.y - rr, width: 2 * rr, height: 2 * rr)),
                           with: .color(Theme.accent), style: StrokeStyle(lineWidth: 2, dash: [3, 2]))
            }
        }

        // Names: your machines only (everyone else's stays an unlabeled dot).
        var nodes: [String: MachineNode] = [:]
        for n in layout.machines { nodes[n.id] = n }
        for label in layout.labels {
            guard let n = nodes[label.id] else { continue }
            let c = t.point(n.x, n.y)
            let ux = label.x - n.x, uy = label.y - n.y
            let len = max(0.001, hypot(ux, uy))
            let gap = t.nodeRadius(n.r) + 8
            let at = CGPoint(x: c.x + CGFloat(ux / len) * gap, y: c.y + CGFloat(uy / len) * gap)
            let anchor: UnitPoint = label.anchor == .leading ? .leading : label.anchor == .trailing ? .trailing : (uy < 0 ? .bottom : .top)
            let text = ctx.resolve(Text(label.text).font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.accent))
            let size = text.measure(in: CGSize(width: 300, height: 40))
            taken.append(CGRect(x: at.x - size.width * anchor.x, y: at.y - size.height * anchor.y, width: size.width, height: size.height))
            ctx.draw(text, at: at, anchor: anchor)
        }

        // Round trips between coordinators, on top of everything drawn so far.
        for (text, rect) in rttLabels {
            ctx.fill(Path(roundedRect: rect, cornerRadius: rect.height / 2), with: .color(Theme.bgBase.opacity(0.9)))
            ctx.draw(text, at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
            taken.append(rect)
        }

        // Coordinator hosts under the hubs, when there is room and nothing else is written there
        // (the host is also in the coordinator's details).
        if t.scale > 0.45 {
            for h in layout.hubs {
                let c = t.point(h.x, h.y + NetworkGraph.ringMax + 16)
                let text = ctx.resolve(Text(NetworkText.hostOf(h.coordinator.url)).font(.system(size: 10, weight: .medium)).foregroundColor(Theme.textSecondary))
                let size = text.measure(in: CGSize(width: 400, height: 40))
                let rect = CGRect(x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height).insetBy(dx: -2, dy: -2)
                if taken.contains(where: { $0.intersects(rect) }) { continue }
                taken.append(rect)
                ctx.draw(text, at: c, anchor: .center)
            }
        }
    }
}

// MARK: - Details

private struct NetworkDetailSheet: View {
    let world: NetworkWorld
    let selection: Selection
    @State private var roundTrip: Double?
    @State private var measuring = false

    var body: some View {
        NavigationStack {
            List { rows }
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var title: String {
        switch selection {
        case .hub: return "Coordinator"
        case .machine(let id):
            guard let a = world.agents.first(where: { $0.id == id }) else { return "Machine" }
            return a.mine ? (a.name ?? "Your machine") : "Someone else's machine"
        }
    }

    @ViewBuilder private var rows: some View {
        switch selection {
        case .hub(let id):
            if let c = world.coordinators.first(where: { $0.id == id }) {
                LabeledContent("Region", value: NetworkText.regionText(region: c.region, country: c.country, continent: c.continent))
                LabeledContent("Address", value: NetworkText.hostOf(c.url))
                LabeledContent("Machines", value: "\(c.agentsOnline) online of \(c.agents)")
                LabeledContent("Status", value: c.reachable ? "Reachable" : "Not reachable")
                LabeledContent("Your round trip") {
                    if measuring { ProgressView() } else { Text(NetworkText.formatMs(roundTrip)) }
                }
                .task { await measure(c) }
                if world.yourRequests.contains(where: { $0.coordinator == id }) {
                    Text("Your request is on this coordinator.").foregroundColor(Theme.accent)
                }
            }
        case .machine(let id):
            if let a = world.agents.first(where: { $0.id == id }) {
                if a.mine {
                    LabeledContent("Name", value: a.name ?? "—")
                    LabeledContent("Model", value: a.activeModel ?? a.models.first ?? "Not reported")
                    LabeledContent("Online", value: a.status == .stale ? "No · not seen lately" : "Yes · \(NetworkText.statusText(a.status).lowercased())")
                    LabeledContent("Activity", value: NetworkText.activityText(a))
                } else {
                    LabeledContent("OS", value: NetworkText.osFamily(a.os))
                    LabeledContent("Activity", value: NetworkText.activityText(a))
                }
                if NetworkGraph.yourPath(world).machines.contains(id) {
                    Text("Serving your request now.").foregroundColor(Theme.accent)
                }
            }
        }
    }

    /// Times one GET of the coordinator's public /identity (https only, no cookies).
    private func measure(_ c: WorldCoordinator) async {
        if NetworkFixture.isEnabled { roundTrip = 42; return }
        guard c.reachable, let raw = c.pingUrl, let url = URL(string: raw), url.scheme == "https" else { return }
        measuring = true
        defer { measuring = false }
        let session = URLSession(configuration: .ephemeral)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5)
        request.httpShouldHandleCookies = false
        // The first request opens the connection; time the second, like a round trip.
        _ = try? await session.data(for: request)
        let start = Date()
        guard (try? await session.data(for: request)) != nil else { return }
        roundTrip = Date().timeIntervalSince(start) * 1000
        session.finishTasksAndInvalidate()
    }
}
