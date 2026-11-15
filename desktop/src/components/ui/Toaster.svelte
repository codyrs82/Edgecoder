<script lang="ts">
  // #24: mounted once, in App.svelte. svelte-sonner's own palette is switched off (unstyled);
  // the look comes from the tokens in src/styles/ui.css. It sits under the header, clear of the
  // composer at the bottom of the window.
  import { Toaster } from "svelte-sonner";
</script>

<Toaster
  position="top-right"
  offset={{ top: 60, right: 16 }}
  mobileOffset={{ top: 60, right: 8, left: 8 }}
  closeButtonAriaLabel="Dismiss"
  toastOptions={{ unstyled: true, class: "ui-toast" }}
/>
