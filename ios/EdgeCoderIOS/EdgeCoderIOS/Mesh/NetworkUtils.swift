// NetworkUtils.swift
// EdgeCoderIOS
//
// Utility to retrieve the device's local WiFi/LAN IP address
// for advertising the mesh HTTP server URL to peers.

import Foundation

enum NetworkUtils {
    /// Return the first non-loopback IPv4 address (typically the WiFi IP).
    static func getLocalIPAddress() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let addr = ptr.pointee.ifa_addr.pointee

            // Skip loopback and down interfaces
            guard (flags & (IFF_UP | IFF_RUNNING)) != 0 else { continue }
            guard (flags & IFF_LOOPBACK) == 0 else { continue }
            guard addr.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                &hostname, socklen_t(hostname.count),
                nil, 0, NI_NUMERICHOST
            )
            if result == 0 {
                let address = String(cString: hostname)
                // Prefer en0 (WiFi) but accept any non-loopback IPv4
                return address
            }
        }
        return nil
    }
}
