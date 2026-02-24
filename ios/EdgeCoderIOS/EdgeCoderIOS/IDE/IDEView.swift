/**
 * IDEView — shows IDE tasks that have been offloaded from a nearby Mac
 * to this iPhone over Bluetooth Local.
 *
 * When a Mac running the EdgeCoder IDE connects via BLE and sends an
 * inference request, it appears here in real-time. The user can see:
 *  - The prompt sent from the Mac
 *  - Whether the task is still running or complete
 *  - The generated output
 *  - How long the phone took (durationMs)
 *
 * A badge on the tab shows the count of running tasks.
 */

import SwiftUI

struct IDEView: View {
    @StateObject private var bt = BluetoothTransport.shared
    @State private var selectedTask: IDETask?

    var body: some View {
        NavigationStack {
            Group {
                if bt.ideTasks.isEmpty {
                    emptyState
                } else {
                    taskList
                }
            }
            .navigationTitle("IDE Tasks")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    connectionBadge
                }
            }
            .sheet(item: $selectedTask) { task in
                IDETaskDetailView(task: task)
            }
        }
    }

    // MARK: - Sub-views

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)

            Text("No IDE Tasks Yet")
                .font(.title2.bold())

            Text("When a Mac running the EdgeCoder IDE sends a task over Bluetooth Local, it will appear here.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            if !bt.isAdvertising {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text("Go to Swarm → set mode to Bluetooth Local to start accepting tasks.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 40)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var taskList: some View {
        List(bt.ideTasks) { task in
            Button {
                selectedTask = task
            } label: {
                IDETaskRow(task: task)
            }
            .buttonStyle(.plain)
        }
        .listStyle(.insetGrouped)
        .animation(.default, value: bt.ideTasks.count)
    }

    @ViewBuilder
    private var connectionBadge: some View {
        if bt.connectedCentralCount > 0 {
            Label("\(bt.connectedCentralCount) Mac", systemImage: "laptopcomputer")
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.blue.opacity(0.15))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
        } else if bt.isAdvertising {
            Label("Waiting…", systemImage: "antenna.radiowaves.left.and.right")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - IDETaskRow

private struct IDETaskRow: View {
    let task: IDETask

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            statusIcon
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.prompt.prefix(80) + (task.prompt.count > 80 ? "…" : ""))
                    .font(.subheadline)
                    .lineLimit(2)

                HStack(spacing: 6) {
                    Text(task.startedAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let ms = task.durationMs {
                        Text("· \(ms)ms")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    statusLabel
                }
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch task.status {
        case .running:
            ProgressView()
                .progressViewStyle(.circular)
                .scaleEffect(0.8)
        case .success:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.title3)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.title3)
        }
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch task.status {
        case .running:
            Text("Running")
                .font(.caption)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.blue.opacity(0.12))
                .foregroundStyle(.blue)
                .clipShape(Capsule())
        case .success:
            Text("Done")
                .font(.caption)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.green.opacity(0.12))
                .foregroundStyle(.green)
                .clipShape(Capsule())
        case .failed:
            Text("Failed")
                .font(.caption)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.red.opacity(0.12))
                .foregroundStyle(.red)
                .clipShape(Capsule())
        }
    }
}

// MARK: - IDETaskDetailView

struct IDETaskDetailView: View {
    let task: IDETask
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {

                    // Header
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Task · \(task.id.prefix(8))…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(task.startedAt, style: .date)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        statusChip
                    }
                    .padding(.horizontal)

                    Divider()

                    // Prompt
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Prompt", systemImage: "text.bubble")
                            .font(.subheadline.bold())
                            .foregroundStyle(.secondary)
                            .padding(.horizontal)

                        Text(task.prompt)
                            .font(.body)
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .padding(.horizontal)
                            .textSelection(.enabled)
                    }

                    // Metrics
                    if let ms = task.durationMs {
                        HStack(spacing: 24) {
                            metricCell(label: "Duration", value: "\(ms) ms")
                            if let completedAt = task.completedAt {
                                metricCell(label: "Completed", value: completedAt.formatted(date: .omitted, time: .standard))
                            }
                            metricCell(label: "Device", value: "This iPhone")
                        }
                        .padding(.horizontal)
                    }

                    // Output
                    if let output = task.output, !output.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("Generated Output", systemImage: "doc.text")
                                .font(.subheadline.bold())
                                .foregroundStyle(.secondary)
                                .padding(.horizontal)

                            Text(output)
                                .font(.system(.body, design: .monospaced))
                                .padding()
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.secondarySystemBackground))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal)
                                .textSelection(.enabled)
                        }
                    } else if task.status == .running {
                        HStack {
                            ProgressView()
                            Text("Generating…")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal)
                    }

                    Spacer(minLength: 40)
                }
                .padding(.top)
            }
            .navigationTitle("Task Detail")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var statusChip: some View {
        switch task.status {
        case .running:
            Label("Running", systemImage: "circle.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(.blue, .blue)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.blue.opacity(0.1))
                .clipShape(Capsule())
        case .success:
            Label("Success", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.green.opacity(0.1))
                .clipShape(Capsule())
        case .failed:
            Label("Failed", systemImage: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.red.opacity(0.1))
                .clipShape(Capsule())
        }
    }

    private func metricCell(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.bold())
        }
    }
}
