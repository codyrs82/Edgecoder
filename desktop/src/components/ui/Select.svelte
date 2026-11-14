<script lang="ts" generics="T extends string">
  // #24: the app's select, on the bits-ui Select primitive (the one shadcn-svelte wraps):
  // a combobox button with a listbox popup, arrow keys, Home/End and type-ahead.
  // Styles: src/styles/ui.css.
  import { Select } from "bits-ui";
  import { Check, ChevronDown } from "@lucide/svelte";

  interface Option {
    value: T;
    label: string;
    disabled?: boolean;
  }
  interface Props {
    value: T | undefined;
    options: readonly Option[];
    onChange?: (value: T) => void;
    /** Accessible name; use `labelledby` instead when a visible label exists. */
    ariaLabel?: string;
    labelledby?: string;
    id?: string;
    disabled?: boolean;
    /** Shown when `value` matches no option. */
    placeholder?: string;
    class?: string;
  }
  // bits-ui reads "" as "nothing selected", but "" is a real choice here ("No schedule", "Any").
  const EMPTY = "\u0000empty";
  const enc = (v: string) => (v === "" ? EMPTY : v);
  const dec = (v: string) => (v === EMPTY ? "" : v) as T;

  let { value = $bindable(), options, onChange, ariaLabel, labelledby, id, disabled = false, placeholder = "Choose…", class: klass = "" }: Props = $props();
</script>

<Select.Root
  type="single"
  value={value !== undefined && options.some((o) => o.value === value) ? enc(value) : ""}
  items={options.map((o) => ({ ...o, value: enc(o.value) }))}
  {disabled}
  onValueChange={(v) => {
    value = dec(v);
    onChange?.(dec(v));
  }}
>
  <Select.Trigger {id} class="ui-select {klass}" aria-label={ariaLabel} aria-labelledby={labelledby}>
    <Select.Value class="ui-select-value" {placeholder} />
    <ChevronDown size={14} aria-hidden="true" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content class="ui-popup ui-select-content" sideOffset={4} collisionPadding={8} aria-label={ariaLabel} aria-labelledby={labelledby}>
      <Select.Viewport>
        {#each options as o (o.value)}
          <Select.Item class="ui-select-item" value={enc(o.value)} label={o.label} disabled={o.disabled}>
            {#snippet children({ selected })}
              <span>{o.label}</span>
              {#if selected}<Check size={13} aria-hidden="true" />{/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
