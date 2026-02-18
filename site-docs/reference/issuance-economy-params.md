# Issuance and Economy Parameters

This page centralizes high-impact economy and issuance controls used by coordinator/economy flows.

## Issuance window controls

| Variable | Typical purpose |
|---|---|
| `ISSUANCE_WINDOW_MS` | rolling issuance window duration |
| `ISSUANCE_RECALC_MS` | recalculation interval |
| `ISSUANCE_BASE_DAILY_POOL_TOKENS` | baseline daily issuance pool |
| `ISSUANCE_MIN_DAILY_POOL_TOKENS` | lower bound for daily pool |
| `ISSUANCE_MAX_DAILY_POOL_TOKENS` | upper bound for daily pool |
| `ISSUANCE_LOAD_CURVE_SLOPE` | load-to-pool response curve factor |
| `ISSUANCE_SMOOTHING_ALPHA` | smoothing factor for issuance transitions |
| `ISSUANCE_COORDINATOR_SHARE` | coordinator share of issuance |
| `ISSUANCE_RESERVE_SHARE` | reserve share allocation |

## Contribution controls

| Variable | Typical purpose |
|---|---|
| `CONTRIBUTION_BURST_CREDITS` | short-term contribution boost handling |
| `MIN_CONTRIBUTION_RATIO` | minimum contribution threshold in allocation logic |

## Anchor and finality controls

| Variable | Typical purpose |
|---|---|
| `ANCHOR_INTERVAL_MS` | anchor generation interval |

## Economic endpoints to monitor

| Path | Why it matters |
|---|---|
| `/economy/issuance/current` | current issuance state |
| `/economy/issuance/history` | historical comparisons |
| `/economy/issuance/recalculate` | forced recalculation for incident handling |
| `/economy/issuance/anchor` | anchor lifecycle |
| `/economy/issuance/anchors` | anchor history and review |
| `/economy/payments/intents` | payment intent lifecycle |
| `/economy/payments/reconcile` | settlement reconciliation |

## Tuning guidance

- Change one high-impact parameter at a time.
- Monitor rolling-window effects across multiple recalculation intervals.
- Keep reserve/coordinator shares aligned with policy and governance.

## Cross-links

- [Credits, Pricing, and Issuance](/economy/credits-pricing-issuance)
- [Settlement Lifecycle](/economy/settlement-lifecycle)
