// #24: one place for transient notifications, backed by svelte-sonner's accessible toaster
// (an aria-live region, so screen readers announce it; pauses on hover/focus).
import { toast } from "svelte-sonner";
import { errorText } from "./errors";

export { errorText };

// A stable id per message means repeated clicks replace the toast instead of stacking copies.
export const notify = {
  success: (message: string, id = message) => toast.success(message, { id }),
  info: (message: string, id = message) => toast.info(message, { id }),
  error: (message: string, err?: unknown, id = message) =>
    toast.error(message, { id, description: err === undefined ? undefined : errorText(err), duration: 8000 })
};
