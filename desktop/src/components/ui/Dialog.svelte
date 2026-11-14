<script lang="ts">
  // #24: the app's one modal shell, on the bits-ui Dialog primitive (the one shadcn-svelte wraps).
  // It supplies the focus trap, focus return, scroll lock and outside-click handling; the caller
  // mounts it with {#if} and unmounts it from onClose. Styles: src/styles/ui.css.
  import { Dialog } from "bits-ui";
  import type { Snippet } from "svelte";
  import { escapeClosesDialog, type EscapeSource } from "../../lib/focus-trap";

  interface Props {
    onClose: () => void;
    /** Accessible name when there is no visible heading; otherwise pass `labelledby`. */
    label?: string;
    labelledby?: string;
    /** center: card; inset: near full-window panel; full: whole window; top: command palette. */
    variant?: "center" | "inset" | "full" | "top";
    /** false: Escape and outside clicks do nothing (first-run setup closes itself). */
    dismissible?: boolean;
    /** true: Escape closes from a text field too (a palette is nothing but its field). */
    escapeInFields?: boolean;
    /** false: the caller places focus itself after closing. */
    restoreFocus?: boolean;
    /** Element to focus on open instead of the first tab stop. */
    initialFocus?: () => HTMLElement | null | undefined;
    /** Width of a `center` dialog (it still shrinks to fit a narrow window). */
    width?: string;
    class?: string;
    children: Snippet;
  }
  let { onClose, label, labelledby, variant = "center", dismissible = true, escapeInFields = false, restoreFocus = true, initialFocus, width, class: klass = "", children }: Props = $props();

  let open = $state(true);

  // Toasts sit outside every dialog; dismissing one is not a click away from the dialog.
  const fromToast = (target: EventTarget | null) => target instanceof Element && target.closest("[data-sonner-toaster]") !== null;

  // Escape is handled here, on the real event, rather than by bits-ui's document listener:
  // that one hands over a copy without a target, and Escape inside a text field, an open
  // menu or a select must not close the whole dialog (see escapeClosesDialog).
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !dismissible) return;
    if (!escapeInFields && !escapeClosesDialog(e as unknown as EscapeSource)) return;
    e.preventDefault();
    onClose();
  }
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) onClose(); }}>
  <Dialog.Portal>
    <Dialog.Overlay class="ui-dialog-overlay ui-dialog-overlay--{variant}" />
    <Dialog.Content
      class="ui-dialog ui-dialog--{variant} {klass}"
      style={width ? `--ui-dialog-width: ${width}` : undefined}
      aria-label={label}
      aria-labelledby={labelledby}
      escapeKeydownBehavior="ignore"
      onkeydown={onKeydown}
      onInteractOutside={(e) => { if (!dismissible || fromToast(e.target)) e.preventDefault(); }}
      onCloseAutoFocus={(e) => { if (!restoreFocus) e.preventDefault(); }}
      onOpenAutoFocus={(e) => {
        const el = initialFocus?.();
        if (el) {
          e.preventDefault();
          el.focus();
        }
      }}
    >
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
