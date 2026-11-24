import UIKit

/// When the iPhone hosts: only on external power (charging, or full while plugged in). Both kinds of
/// hosting follow it: coordinator network jobs (/pull -> local model -> /result) and serving nearby
/// machines over Bluetooth (advertising and running their prompts). The phone's own use of Bluetooth
/// as a client (scanning for nearby machines and sending them its own chats) does not depend on it.
enum HostingPowerPolicy {
    static func mayHost(_ batteryState: UIDevice.BatteryState) -> Bool {
        batteryState == .charging || batteryState == .full
    }

    /// The reply a nearby machine gets when it sends a prompt while the phone is on battery.
    static let notChargingReply = "This iPhone serves nearby machines only while it is charging."
}
