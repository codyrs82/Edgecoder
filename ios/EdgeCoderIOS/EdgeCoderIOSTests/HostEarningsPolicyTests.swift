import XCTest

final class HostEarningsPolicyTests: XCTestCase {
    func testEarningsInAppOnlyWhenTheBuildSettingIsOn() {
        XCTAssertTrue(HostEarningsPolicy.enabled(raw: "YES"))
        XCTAssertTrue(HostEarningsPolicy.enabled(raw: " true "))
        XCTAssertFalse(HostEarningsPolicy.enabled(raw: "NO"))
        XCTAssertFalse(HostEarningsPolicy.enabled(raw: ""))
        XCTAssertFalse(HostEarningsPolicy.enabled(raw: nil), "missing key: off, as in Release")
    }

    func testEarningsReasonsAreTheHostOnes() {
        for r in ["compute_contribution:task-1", "payout:abc", "payout_refund:abc", "payout_fee_excess:x", "fee_pool_distribution:d"] {
            XCTAssertTrue(HostEarningsPolicy.isEarningsReason(r), r)
        }
        for r in ["credit_purchase:inv", "inference:call", "inference_reserve:call", "task_submit:t", "compute_reservation:r"] {
            XCTAssertFalse(HostEarningsPolicy.isEarningsReason(r), r)
        }
    }
}
