import SwiftUI
import BackgroundTasks

@main
struct EdgeCoderIOSApp: App {
    @StateObject private var sessionStore = SessionStore()
    @StateObject private var swarmRuntime = SwarmRuntimeController.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Register background tasks for BLE mesh and inference
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: "io.edgecoder.ble-mesh",
            using: nil
        ) { task in
            guard let processingTask = task as? BGProcessingTask else { return }
            processingTask.expirationHandler = {
                processingTask.setTaskCompleted(success: false)
            }
            // Keep BLE alive — CoreBluetooth handles this natively with background modes,
            // but this task ensures the process stays active for inference
            Task {
                // Schedule the next background task before completing
                EdgeCoderIOSApp.scheduleBackgroundBLETask()
                processingTask.setTaskCompleted(success: true)
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(sessionStore)
                .environmentObject(swarmRuntime)
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background:
                // Schedule background processing when app enters background
                EdgeCoderIOSApp.scheduleBackgroundBLETask()
                print("[App] entered background — BLE background modes active, task scheduled")
            case .active:
                print("[App] entered foreground")
            default:
                break
            }
        }
    }

    static func scheduleBackgroundBLETask() {
        let request = BGProcessingTaskRequest(identifier: "io.edgecoder.ble-mesh")
        request.requiresNetworkConnectivity = false
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60) // 1 minute
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[App] failed to schedule background BLE task: \(error)")
        }
    }
}
