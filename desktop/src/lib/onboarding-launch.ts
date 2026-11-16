// When the app opens the Getting started guide by itself (App.svelte): a #/welcome/<step> route
// always does; otherwise the portal decides (first sign-in, or a guide still in progress), and a
// portal that doesn't answer never interrupts.
import { stepFromRoute, type StepId } from "./onboarding";

export async function guideToOpen(
  hash: string,
  fetchAnswer: () => Promise<{ show: boolean; state: { current: StepId } | null }>,
): Promise<StepId | "saved" | null> {
  const fromHash = stepFromRoute(hash);
  if (fromHash) return fromHash;
  try {
    const r = await fetchAnswer();
    return r.show ? (r.state?.current ?? "saved") : null;
  } catch {
    return null;
  }
}
