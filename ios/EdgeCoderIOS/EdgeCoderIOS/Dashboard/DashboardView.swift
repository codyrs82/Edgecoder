import SwiftUI

struct DashboardView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @EnvironmentObject private var swarmRuntime: SwarmRuntimeController
    @State private var dashboard: DashboardPayload?
    @State private var agentContribution: AgentContributionPayload?
    @State private var agentContributionLoading = false
    @State private var agentContributionError = ""
    @State private var errorText = ""
    @State private var enrollmentStatusText = ""
    @State private var loading = false
    @State private var requiresAuth = false
    @State private var loadPhase = "idle"
    @State private var loadStartedAt: Date?
    @State private var watchdogToken = UUID()

    var body: some View {
        NavigationStack {
            List {
                Section("State") {
                    Text("Phase: \(loadPhase)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let started = loadStartedAt {
                        Text("Started: \(started.formatted(date: .omitted, time: .standard))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                if requiresAuth {
                    Section("Authentication required") {
                        Text("Sign in from the Auth tab to load dashboard stats.")
                            .foregroundStyle(.secondary)
                    }
                }
                if let dashboard {
                    Section("Contribution") {
                        LabeledContent("Credits earned", value: String(format: "%.3f", dashboard.contribution.earnedCredits))
                        LabeledContent("Tasks completed", value: String(dashboard.contribution.contributedTaskCount))
                        let sats = dashboard.walletSnapshot?.quote?.estimatedSats ?? 0
                        let btc = Double(sats) / 100_000_000.0
                        LabeledContent("Estimated sats value", value: String(sats))
                        LabeledContent("Estimated BTC value", value: String(format: "%.8f BTC", btc))
                    }

                    Section("This device") {
                        let currentId = swarmRuntime.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
                        if currentId.isEmpty {
                            Text("Set a Node ID in Settings or Swarm to view this device's contribution.")
                                .foregroundStyle(.secondary)
                        } else {
                            LabeledContent("Node ID", value: currentId)

                            if agentContributionLoading {
                                ProgressView("Loading this device...")
                            } else if let agentContribution {
                                LabeledContent("Agent credits earned", value: String(format: "%.3f", agentContribution.contribution.earnedCredits))
                                LabeledContent("Agent tasks completed", value: String(agentContribution.contribution.contributedTaskCount))
                                LabeledContent("Agent balance", value: String(format: "%.3f", agentContribution.wallet.balance))
                                LabeledContent("Agent estimated sats", value: String(agentContribution.wallet.estimatedSats))
                                LabeledContent("Sats per credit", value: String(agentContribution.wallet.satsPerCredit))
                                LabeledContent("Connected", value: (agentContribution.runtime?.connected ?? false) ? "yes" : "no")
                                LabeledContent("Mode", value: agentContribution.runtime?.mode ?? "n/a")
                                LabeledContent("Model provider", value: agentContribution.runtime?.localModelProvider ?? "n/a")
                                LabeledContent("Max concurrent tasks", value: String(agentContribution.runtime?.maxConcurrentTasks ?? 0))
                                if !agentContribution.recentTaskIds.isEmpty {
                                    Text("Recent task IDs: \(agentContribution.recentTaskIds.joined(separator: ", "))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                Text("Load contribution for this device.")
                                    .foregroundStyle(.secondary)
                            }

                            if !agentContributionError.isEmpty {
                                Text(agentContributionError)
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                    }

                    Section("Network") {
                        let totals = dashboard.networkSummary?.capacity?.totals
                        LabeledContent("Total capacity", value: String(totals?.totalCapacity ?? 0))
                        LabeledContent("Connected agents", value: String(totals?.agentsConnected ?? 0))
                        LabeledContent("Queued jobs", value: String(dashboard.networkSummary?.status?.queued ?? 0))
                        LabeledContent("Completed jobs", value: String(dashboard.networkSummary?.status?.results ?? 0))
                    }

                    Section("Wallet snapshot") {
                        LabeledContent("Credits", value: String(format: "%.3f", dashboard.walletSnapshot?.credits?.balance ?? 0))
                        LabeledContent("Estimated sats", value: String(dashboard.walletSnapshot?.quote?.estimatedSats ?? 0))
                        LabeledContent("Sats per credit", value: String(dashboard.walletSnapshot?.quote?.satsPerCredit ?? 0))
                    }

                    Section("Recent token events") {
                        let events = (dashboard.walletSnapshot?.creditHistory ?? []).prefix(5)
                        if events.isEmpty {
                            Text("No token/credit events yet.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(Array(events.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(item.type ?? "n/a") | \(item.reason ?? "n/a")")
                                        .font(.caption)
                                    Text("credits: \(item.credits ?? 0, specifier: "%.3f") | task: \(item.relatedTaskId ?? "-")")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                } else if loading {
                    ProgressView("Loading dashboard...")
                } else {
                    Text("No dashboard data. Sign in and refresh.")
                }

                if !errorText.isEmpty {
                    Section("Error") {
                        Text(errorText)
                            .foregroundStyle(.red)
                    }
                }
                if !enrollmentStatusText.isEmpty {
                    Section("Device enrollment") {
                        Text(enrollmentStatusText)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Dashboard")
            .refreshable {
                await load()
            }
            .toolbar {
                Button("Refresh") {
                    Task { await load() }
                }
            }
            .task {
                await load()
            }
            .onChange(of: swarmRuntime.agentId) { _, _ in
                Task { await loadSelectedAgentContribution() }
            }
        }
    }

    private func load() async {
        let token = UUID()
        watchdogToken = token
        loadStartedAt = Date()
        loading = true
        loadPhase = "starting"
        defer { loading = false }
        requiresAuth = false
        startWatchdog(token: token)
        if !sessionStore.isAuthenticated {
            loadPhase = "checking_session"
            await sessionStore.refreshSession()
        }
        if !sessionStore.isAuthenticated {
            dashboard = nil
            requiresAuth = true
            errorText = ""
            loadPhase = "auth_required"
            return
        }
        do {
            loadPhase = "requesting_dashboard"
            dashboard = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/ios/dashboard",
                method: "GET"
            )
            let didEnroll = await ensureCurrentDeviceNodeEnrollment()
            if didEnroll {
                dashboard = try await APIClient.shared.request(
                    baseURL: APIClient.shared.config.portalBaseURL,
                    path: "/ios/dashboard",
                    method: "GET"
                )
            }
            await loadSelectedAgentContribution()
            errorText = ""
            loadPhase = "loaded"
        } catch is CancellationError {
            // SwiftUI may cancel in-flight tasks during view/task lifecycle updates.
            // Treat cancellations as non-fatal to avoid flashing false errors.
            errorText = ""
            if loadPhase != "loaded" {
                loadPhase = "cancelled"
            }
        } catch {
            let message = error.localizedDescription
            errorText = message
            if message.contains("not_authenticated") {
                requiresAuth = true
            }
            loadPhase = "failed"
        }
    }

    private func ensureCurrentDeviceNodeEnrollment() async -> Bool {
        guard let dashboard else { return false }
        let currentAgentId = swarmRuntime.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !currentAgentId.isEmpty else { return false }
        let alreadyPresent = dashboard.nodes.contains(where: { $0.nodeId == currentAgentId && $0.nodeKind == "agent" })
        if alreadyPresent {
            enrollmentStatusText = ""
            return false
        }
        do {
            struct EnrollBody: Encodable {
                let nodeId: String
                let nodeKind: String
            }
            let payload: EnrollmentResponse = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/nodes/enroll",
                method: "POST",
                body: EnrollBody(nodeId: currentAgentId, nodeKind: "agent")
            )
            swarmRuntime.registrationToken = payload.registrationToken
            swarmRuntime.persistRuntimeSettings()
            enrollmentStatusText = "Enrolled this iPhone as \(currentAgentId)."
            return true
        } catch is CancellationError {
            // No-op; a newer load likely superseded this request.
            return false
        } catch {
            enrollmentStatusText = "This iPhone is not yet enrolled: \(error.localizedDescription)"
            return false
        }
    }

    private func loadSelectedAgentContribution() async {
        let currentAgentId = swarmRuntime.agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !currentAgentId.isEmpty else {
            agentContribution = nil
            agentContributionError = ""
            return
        }
        agentContributionLoading = true
        defer { agentContributionLoading = false }
        do {
            let encodedAgentId = currentAgentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? currentAgentId
            agentContribution = try await APIClient.shared.request(
                baseURL: APIClient.shared.config.portalBaseURL,
                path: "/ios/agents/\(encodedAgentId)/contribution",
                method: "GET"
            )
            agentContributionError = ""
        } catch is CancellationError {
            agentContributionError = ""
            return
        } catch {
            agentContribution = nil
            agentContributionError = error.localizedDescription
        }
    }

    private func startWatchdog(token: UUID) {
        Task {
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            guard token == watchdogToken else { return }
            guard loading else { return }
            loading = false
            if errorText.isEmpty && !requiresAuth {
                errorText = "Dashboard request watchdog timeout. Open Auth tab and sign in, then refresh."
            }
            if loadPhase != "loaded" && loadPhase != "failed" {
                loadPhase = "watchdog_timeout"
            }
        }
    }
}
