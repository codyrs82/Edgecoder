// This machine's agent was refused by the network's safety checks (blacklisted by behavioural
// monitoring, or by an admin). The app says so, with the reason and a way to ask for a review,
// instead of a generic "Not connected". The reason comes from the agent (/v1/ide/compute paused).

export const REVIEW_EMAIL = "support@edgecoder.io";

/** "This Mac" on macOS, else "This computer". */
export function thisMachineLabel(platform: string = typeof navigator === "undefined" ? "" : navigator.platform ?? ""): string {
  return /mac/i.test(platform) ? "This Mac" : "This computer";
}

/** The coordinator's reason without its machine prefix ("Auto-blacklisted by behavioral monitoring: "). */
export function pausedReasonText(reason: string): string {
  const r = reason.replace(/^Auto-blacklisted by behavioral monitoring:\s*/i, "").trim();
  return r || "no reason given";
}

/** A mailto: link asking for a review, with the agent id and the reason filled in. */
export function reviewMailto(reason: string, agentId?: string): string {
  const subject = "Review request: my machine was paused";
  const body = [
    "My machine was paused by the network's safety check. Please review it.",
    "",
    `Agent: ${agentId ?? "(unknown)"}`,
    `Reason: ${reason}`,
  ].join("\n");
  return `mailto:${REVIEW_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
