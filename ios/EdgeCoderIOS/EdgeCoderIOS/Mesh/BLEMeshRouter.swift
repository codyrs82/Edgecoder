// BLEMeshRouter.swift
// EdgeCoderIOS
//
// Cost-based BLE mesh router that selects the best peer for task offloading.
// The cost function is model-agnostic — any model can serve any task. Smaller
// models incur a graduated preference penalty but are never hard-rejected.
//
// Cost formula and quality multiplier must stay in sync with the TypeScript
// implementation in src/mesh/ble/ble-router.ts and ble-mesh-manager.ts.

import Foundation

struct BLEMeshRouter {
    static let costThreshold: Double = 200

    /// Compute a composite routing cost for a peer.
    ///
    /// `cost = modelPreferencePenalty + loadPenalty + batteryPenalty + signalPenalty`
    ///
    /// - `modelPreferencePenalty`: graduated – smaller models cost more but are never rejected
    /// - `loadPenalty`: 20 points per active task slot
    /// - `batteryPenalty`: phones lose 0.5 per missing battery percent (desktops exempt)
    /// - `signalPenalty`: up to 30 points based on RSSI distance from -30 dBm
    static func computeCost(peer: BLEPeer, requiredModelSize: Double = 0) -> Double {
        // Graduated model preference: smaller models cost more but are never rejected
        let modelPreferencePenalty = max(0, (7.0 - peer.modelParamSize) * 8.0)
        let loadPenalty = Double(peer.currentLoad) * 20
        let batteryPenalty: Double = peer.deviceType == "phone"
            ? Double(100 - peer.batteryPct) * 0.5
            : 0
        let signalPenalty = min(30, max(0, Double(-peer.rssi - 30) * 0.5))
        return modelPreferencePenalty + loadPenalty + batteryPenalty + signalPenalty
    }

    /// Select the lowest-cost peer whose cost is below `costThreshold`.
    /// Returns `nil` when no peer qualifies.
    static func selectBestPeer(from peers: [BLEPeer], requiredModelSize: Double = 0) -> BLEPeer? {
        var best: BLEPeer?
        var bestCost = costThreshold
        for peer in peers {
            let cost = computeCost(peer: peer, requiredModelSize: requiredModelSize)
            if cost < bestCost {
                bestCost = cost
                best = peer
            }
        }
        return best
    }

    /// Maps model parameter size (in billions) to a credit quality multiplier.
    ///
    /// Larger models earn full credit; smaller models earn proportionally less.
    /// Must match `modelQualityMultiplier` in `src/mesh/ble/ble-mesh-manager.ts`.
    static func modelQualityMultiplier(paramSize: Double) -> Double {
        if paramSize >= 7 { return 1.0 }
        if paramSize >= 3 { return 0.7 }
        if paramSize >= 1.5 { return 0.5 }
        return 0.3
    }
}
