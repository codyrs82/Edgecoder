// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EdgeCoderBLEProxy",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "edgecoder-ble-proxy",
            path: "Sources"
        )
    ]
)
