# iOS App — Power & Background Behavior

This page covers what the current iOS app does about battery, power and background work, and how the coordinator treats a phone's power readings. For using the app (the **Chat**, **Bots**, **Wallet**, **Machines** and **Network** tabs), see the [iOS app guide](/guide/ios-app).

::: warning Removed from the app
Older builds had a three-way compute mode picker (**Off / On / Bluetooth Local**) in a **Swarm** tab, an automatic switch to Bluetooth Local when the internet dropped, and an **IDE** tab that listed tasks a Mac sent to the phone over Bluetooth. None of these exist in the current app. The IDE tab was replaced by **Machines** in build 34 (#429).
:::

## Hosting

The phone loads a model and runs it on the device. It hosts in two ways: it runs network jobs from the coordinator **only while it is charging** (on external power: charging or full), and it serves nearby machines over Bluetooth whenever hosting is on. The controls are in **Settings** (bottom of the Chat drawer):

| Card | What it shows or controls |
|---|---|
| **Hosting** | State (Stopped / Running / Paused), whether the phone is charging, start, pause and stop buttons, network jobs done and failed, Bluetooth requests served and failed (this session), and **Auto-start on launch** (on by default). Pause stops network jobs and heartbeats; Bluetooth keeps serving. |
| **Local Model** | Pick, download and load the on-device model. |
| **Network** | Nearby peers, battery percent, and power source (`AC` or `Bat`). |

After you sign in, the app enrolls the phone (`POST /nodes/enroll`) and, if **Auto-start on launch** is on, starts hosting. While running, it registers with the coordinator as an agent (`os: "ios"`, `clientType: "edgecoder-ios"`, one task at a time) and sends a heartbeat about every 15 seconds, on battery too: Bluetooth needs the account from registration and the heartbeat's offline/online signal. It asks for network jobs only while charging and only when the on-device model is loaded.

Charging is required for network jobs; there is no setting for it (older builds had a **Run only when charging** toggle, off by default). The app watches the battery state: when you unplug, it pulls no new job (a job already running finishes and reports) and sends a heartbeat at once so the coordinator knows; when you plug back in, it resumes.

## Power telemetry

Every `/register` and `/heartbeat` from the phone carries a `powerTelemetry` object:

| Field | Meaning |
|---|---|
| `onExternalPower` | Battery state is charging or full |
| `batteryLevelPct` | Battery percentage (0–100) |
| `lowPowerMode` | iOS Low Power Mode is on |
| `updatedAtMs` | When the reading was taken |

The app does not report thermal state. Thermal throttling in the coordinator applies only to desktop agents that send `thermalState`.

## Coordinator power policy

When an iOS agent (`os: "ios"` or `clientType: "edgecoder-ios"`) calls `/pull` and its latest power telemetry (from `/register` or `/heartbeat`) does not say `onExternalPower: true`, or it sent none, the coordinator gives it no job: `{ "subtask": null, "powerDeferred": true, "reason": "ios_not_charging" }` (`iosAgentNotCharging` in `src/swarm/power-policy.ts`). This also holds back older app builds that pulled on battery.

A charging phone then goes through `evaluateIosPowerPolicy` (same file), where rule 1 or 2 decides. Rules 3 to 5 cover a phone on battery; since such a phone gets no job anyway, they now only show in `/capacity`. The first matching rule wins:

| Order | Condition | Result | `reason` |
|---|---|---|---|
| 1 | Low Power Mode on | No work | `ios_low_power_mode` |
| 2 | On external power | Work allowed | `ios_external_power` |
| 3 | Battery ≤ `IOS_BATTERY_TASK_STOP_LEVEL_PCT` (default `20`) | No work | `ios_battery_critical` |
| 4 | Last assignment less than `IOS_BATTERY_PULL_MIN_INTERVAL_MS` ago (default `45000`) | No work yet | `ios_on_battery_throttled` |
| 5 | Otherwise | Work allowed | `ios_on_battery_lite_mode` |

When work is held back, `/pull` answers `{ "subtask": null, "powerDeferred": true, "reason": "<reason>" }` and the phone tries again on its next poll. Both thresholds are coordinator settings; see [Environment Variables](/reference/environment-variables).

## Background execution

The app declares these background modes in `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>fetch</string>
  <string>processing</string>
  <string>bluetooth-central</string>
  <string>bluetooth-peripheral</string>
</array>
```

Each time the app goes to the background it submits these `BGTaskScheduler` requests:

| Task ID | Type | Request |
|---|---|---|
| `io.edgecoder.ios.runtime` | `BGProcessingTask` | Needs external power |
| `io.edgecoder.ios.heartbeat` | `BGAppRefreshTask` | Earliest 15 minutes later |
| `io.edgecoder.ble-mesh` | `BGProcessingTask` | Needs external power; earliest 1 minute later |

iOS decides whether and when these run. The handlers only keep the process alive for a while and schedule the next request; heartbeats and task polling happen in the hosting loop. Do not expect a backgrounded phone to keep taking work. On battery it takes no network jobs at all.

## Nearby devices (Bluetooth)

The chat model picker shows a **Nearby Devices** section only when the runtime's Bluetooth mesh has discovered a peer. This path is not tested end to end, so don't rely on it. The older transport that made the phone a Bluetooth peripheral for a Mac (`BluetoothTransport`, used with `edgecoder-ble-proxy`) is still compiled into the app, but nothing in the current app starts it (#429).

## Cross-links

- [iOS app guide](/guide/ios-app)
- [Public Mesh Operations](/operations/public-mesh-operations)
- [Environment Variables](/reference/environment-variables)
