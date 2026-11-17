// #24: the app's toasts, on svelte-sonner (the toast shadcn-svelte ships). One place decides how
// each kind behaves: errors stay until dismissed, everything else leaves by itself.
import { toast } from "svelte-sonner";

export type ToastKind = "error" | "info" | "success";

/** `id` makes a later toast replace an earlier one from the same source instead of stacking. */
/** `durationMs`: how long a non-error toast stays (the library default otherwise). */
export function notify(text: string, kind: ToastKind = "info", id?: string, durationMs?: number): void {
  if (kind === "error") toast.error(text, { id, duration: Number.POSITIVE_INFINITY, closeButton: true });
  else toast[kind](text, durationMs ? { id, duration: durationMs } : { id });
}
