import XCTest

final class WithdrawPolicyTests: XCTestCase {
    func testWithdrawInAppOnlyWhenTheBuildSettingIsOn() {
        XCTAssertTrue(WithdrawPolicy.enabled(raw: "YES"))
        XCTAssertTrue(WithdrawPolicy.enabled(raw: " true "))
        XCTAssertFalse(WithdrawPolicy.enabled(raw: "NO"))
        XCTAssertFalse(WithdrawPolicy.enabled(raw: ""))
        XCTAssertFalse(WithdrawPolicy.enabled(raw: nil), "missing key: off, as in Release")
    }
}
