// BLEChunkedTransfer.swift
// EdgeCoderIOS
//
// Chunk encode/decode logic matching the TypeScript implementation
// in src/mesh/ble/protocol.ts. Each chunk has a 4-byte header:
//   - bytes 0-1: sequence number (UInt16, big-endian)
//   - bytes 2-3: total chunk count (UInt16, big-endian)

import Foundation

struct BLEChunkedTransfer {

    /// Splits `data` into MTU-sized chunks, each prefixed with a 4-byte header
    /// containing the sequence number and total chunk count (big-endian UInt16).
    ///
    /// - Parameters:
    ///   - data: The payload to chunk.
    ///   - mtu: Maximum transmission unit (includes header). Defaults to `BLEMeshConstants.defaultMTU`.
    /// - Returns: An ordered array of chunks ready for BLE transmission.
    static func encode(data: Data, mtu: Int = BLEMeshConstants.defaultMTU) -> [Data] {
        let chunkDataSize = mtu - BLEMeshConstants.chunkHeaderSize
        guard chunkDataSize > 0 else { return [] }

        let totalChunks = max(1, Int(ceil(Double(data.count) / Double(chunkDataSize))))
        var chunks: [Data] = []
        chunks.reserveCapacity(totalChunks)

        for i in 0..<totalChunks {
            var header = Data(count: BLEMeshConstants.chunkHeaderSize)
            header.withUnsafeMutableBytes { buf in
                buf.storeBytes(of: UInt16(i).bigEndian, toByteOffset: 0, as: UInt16.self)
                buf.storeBytes(of: UInt16(totalChunks).bigEndian, toByteOffset: 2, as: UInt16.self)
            }
            let start = i * chunkDataSize
            let end = min(start + chunkDataSize, data.count)
            chunks.append(header + data[start..<end])
        }

        return chunks
    }

    /// Reassembles chunked data by sorting on the sequence number in each chunk header
    /// and concatenating the payloads (everything after the 4-byte header).
    ///
    /// - Parameter chunks: An unordered collection of chunks produced by `encode`.
    /// - Returns: The original reassembled payload.
    static func decode(chunks: [Data]) -> Data {
        guard !chunks.isEmpty else { return Data() }

        let sorted = chunks.sorted { a, b in
            let seqA = a.withUnsafeBytes { $0.load(as: UInt16.self).bigEndian }
            let seqB = b.withUnsafeBytes { $0.load(as: UInt16.self).bigEndian }
            return seqA < seqB
        }

        var result = Data()
        for chunk in sorted {
            guard chunk.count > BLEMeshConstants.chunkHeaderSize else { continue }
            result.append(chunk.dropFirst(BLEMeshConstants.chunkHeaderSize))
        }
        return result
    }
}
