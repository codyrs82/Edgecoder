import XCTest

/// desktop/src/lib/served.ts parity (expected values come from running the TypeScript).
final class ServedFormatterTests: XCTestCase {
    private let served = ServedInfo(label: "m1", own: false, computeClass: "gpu", tier: "t2", hardware: "Datacenter GPU (x)", gpu: "2× NVIDIA A16",
                                    region: "us-central", city: "Chicago", country: "US", promptMs: 81000, genMs: 6500, promptTokens: 24800, outputTokens: 312)

    func testNetworkLine() {
        XCTAssertEqual(ServedFormatter.servedLine([CallUsage(cSats: 3.4, model: "network/qwen3-coder:30b", served: served)]),
                       "qwen3-coder:30b · Datacenter GPU 2×A16 · Chicago · read 24.8k tok in 81 s · wrote 312 tok in 6.5 s · 3.4 cSats")
    }

    func testOwnMachinesAreFree() {
        var a = served
        a.computeClass = "local"; a.hardware = "This computer (Apple M1 Max)"; a.gpu = nil; a.city = nil; a.region = nil; a.country = nil; a.own = true
        a.promptTokens = 1500; a.promptMs = 2000; a.outputTokens = 120_000; a.genMs = 900
        var b = served
        b.label = "m2"; b.computeClass = "local"; b.hardware = "x"; b.own = true
        XCTAssertEqual(ServedFormatter.servedLine([CallUsage(cSats: 0, model: "llama3", served: a), CallUsage(cSats: 0, served: b)]),
                       "x · Chicago · 2 machines · read 26.3k tok in 83 s · wrote 120k tok in 7.4 s · 2 calls · free")
    }

    func testHardwareShortAndNoServed() {
        var s = served
        s.gpu = nil; s.own = true
        XCTAssertEqual(ServedFormatter.hardwareShort(s), "Datacenter GPU (t2) · your machine")
        XCTAssertNil(ServedFormatter.servedLine([CallUsage(cSats: 1)]))
        XCTAssertNil(ServedFormatter.servedLine(nil))
    }
}
