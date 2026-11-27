<script lang="ts">
  // The Bits icon (bit-avatars.ts bitsMarkSvg): the smiling Coin bit. Decorative next to a label.
  import { bitsMarkSvg } from "../lib/bit-avatars";

  let { size = 16 }: { size?: number } = $props();
  const svg = bitsMarkSvg().replace(/ width="48" height="48" role="img" aria-label="Bits"><title>Bits<\/title>/, ` width="${size}" height="${size}" aria-hidden="true" focusable="false">`);
</script>

<span class="bits-mark" style="width: {size}px; height: {size}px">{@html svg}</span>

<style>
  .bits-mark {
    display: inline-flex;
    flex-shrink: 0;
  }
</style>
