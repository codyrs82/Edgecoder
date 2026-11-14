<script lang="ts">
  import Select from "../../src/components/ui/Select.svelte";
  let { onChange }: { onChange?: (v: string) => void } = $props();
  let value = $state("light");
</script>

<Select ariaLabel="Theme" bind:value {onChange} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
<output>{value}</output>
