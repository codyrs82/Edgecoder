import XCTest

/// src/common/buy-limits.ts parity (expected values come from running the TypeScript).
final class BuyLimitsTests: XCTestCase {
    private let launch = LaunchCaps(mode: "invite", maxBuySatsPerDay: 50_000, maxBalanceSats: 100_000, maxPayoutSatsPerDay: nil, boughtWindowSats: 20_000)

    func testBalanceCapWithFee() {
        let l = BuyLimits.limit(launch: launch, balanceCSats: 95_000, feeBps: 100)
        XCTAssertEqual(l, BuyLimit(minSats: 100, maxSats: 5_050, reason: .balance, dailyCapSats: 50_000, dailyLeftSats: 30_000, balanceCapSats: 100_000, balanceLeftSats: 5_000))
        XCTAssertEqual(BuyLimits.rangeLabel(l), "100 to 5,050")
        XCTAssertEqual(BuyLimits.limitText(10_000, l), "Early access: a balance of up to 100,000 cSats. You can add up to 5,050 sats now.")
    }

    func testDailyCap() {
        let l = BuyLimits.limit(launch: launch, balanceCSats: 0, feeBps: 0)
        XCTAssertEqual(l.maxSats, 30_000)
        XCTAssertEqual(l.reason, .daily)
        XCTAssertEqual(BuyLimits.rangeLabel(l), "100 to 30,000 today")
        XCTAssertEqual(BuyLimits.limitText(40_000, l), "Early access: up to 50,000 sats per day (30,000 left today).")
        XCTAssertTrue(BuyLimits.fits(30_000, l))
        XCTAssertFalse(BuyLimits.fits(30_001, l))
        XCTAssertEqual(BuyLimits.clamp(99_999, l), 30_000)
    }

    func testOpenLaunchAndNothingLeft() {
        let open = BuyLimits.limit(launch: nil, balanceCSats: 0, feeBps: nil)
        XCTAssertEqual(BuyLimits.rangeLabel(open), "100 to 1M")
        XCTAssertEqual(BuyLimits.limitText(2_000_000, open), "The most you can buy at once is 1,000,000 sats.")
        XCTAssertEqual(BuyLimits.limitText(50, open), "The minimum is 100 sats.")
        var spent = launch
        spent.boughtWindowSats = 50_000
        XCTAssertEqual(BuyLimits.rangeLabel(BuyLimits.limit(launch: spent, balanceCSats: 0, feeBps: 0)), "None left today")
    }

    func testErrorTexts() {
        XCTAssertEqual(BuyLimits.errorText("launch_buy_daily_cap", remainingSats: 0, limitSats: 50_000),
                       "You've reached today's early-access limit of 50,000 sats. You can buy more once some of today's purchases are 24 hours old.")
        XCTAssertEqual(BuyLimits.errorText("launch_buy_daily_cap", remainingSats: 1_234, limitSats: 50_000),
                       "That's over today's early-access limit. You can buy up to 1,234 sats more today.")
        XCTAssertEqual(BuyLimits.errorText("launch_balance_cap", remainingSats: 500, limitSats: 100_000),
                       "That would take your balance over the early-access limit of 100,000 cSats. You can add up to 500 cSats now.")
        XCTAssertEqual(BuyLimits.errorText("weird"), "Couldn't start the payment. Try again in a minute.")
    }
}
