// #24: the app's toasts, on svelte-sonner (the toast shadcn-svelte ships). One place decides how
// each kind behaves: errors stay until dismissed, everything else leaves by itself.
import { toast } from "svelte-sonner";

export type ToastKind = "error" | "info" | "success";

/** `id` makes a later toast replace an earlier one from the same source instead of stacking. */
export function notify(text: string, kind: ToastKind = "info", id?: string): void {
  if (kind === "error") toast.error(text, { id, duration: Number.POSITIVE_INFINITY, closeButton: true });
  else toast[kind](text, { id });
}
