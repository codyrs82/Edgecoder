import UIKit
import BackgroundTasks

// MARK: - Background task identifiers
// Register these in Xcode → Signing & Capabilities → Background Tasks
// (or the entitlements file). BGProcessingTask is used for long-running
// compute bursts; BGAppRefreshTask wakes the app briefly to heartbeat.
private let bgProcessingTaskId = "io.edgecoder.ios.runtime"
private let bgRefreshTaskId    = "io.edgecoder.ios.heartbeat"

final class AppDelegate: NSObject, UIApplicationDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        registerBackgroundTasks()
        return true
    }

    // MARK: - Background task registration

    private func registerBackgroundTasks() {
        // Long-running processing task: keeps the runtime loop alive while
        // backgrounded. iOS may grant up to several minutes of runtime.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: bgProcessingTaskId,
            using: nil
        ) { task in
            self.handleProcessingTask(task as! BGProcessingTask)
        }

        // Short refresh task: heartbeat-only wake when processing task isn't running.
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: bgRefreshTaskId,
            using: nil
        ) { task in
            self.handleRefreshTask(task as! BGAppRefreshTask)
        }
    }

    // MARK: - Background task handlers

    private func handleProcessingTask(_ task: BGProcessingTask) {
        // Re-schedule immediately so we chain tasks after iOS terminates this one.
        Self.scheduleProcessingTask()
        Self.scheduleRefreshTask()

        let controller = SwarmRuntimeController.shared
        let runtimeTask = Task {
            // Keep heartbeating until iOS cancels the background task.
            while !Task.isCancelled {
                if await controller.state == .running {
                    // Heartbeat is sent inside the runtime loop; just keep alive.
                }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }

        task.expirationHandler = {
            runtimeTask.cancel()
        }

        // The task completes when the loop above exits (on cancellation).
        Task {
            _ = await runtimeTask.result
            task.setTaskCompleted(success: true)
        }
    }

    private func handleRefreshTask(_ task: BGAppRefreshTask) {
        Self.scheduleRefreshTask()

        let controller = SwarmRuntimeController.shared
        let heartbeatTask = Task {
            if await controller.state == .running {
                // Heartbeat is handled by the runtime loop.
            }
        }

        task.expirationHandler = {
            heartbeatTask.cancel()
        }

        Task {
            _ = await heartbeatTask.result
            task.setTaskCompleted(success: true)
        }
    }

    // MARK: - Schedule background tasks

    /// Call this when the app is about to background and compute is active.
    static func scheduleBackgroundTasksIfNeeded() {
        scheduleProcessingTask()
        scheduleRefreshTask()
    }

    static func scheduleProcessingTask() {
        let request = BGProcessingTaskRequest(identifier: bgProcessingTaskId)
        request.requiresNetworkConnectivity = false  // also runs in BT Local mode
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 1)
        try? BGTaskScheduler.shared.submit(request)
    }

    static func scheduleRefreshTask() {
        let request = BGAppRefreshTaskRequest(identifier: bgRefreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 min
        try? BGTaskScheduler.shared.submit(request)
    }
}
