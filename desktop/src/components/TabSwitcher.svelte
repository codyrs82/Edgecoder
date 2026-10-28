<script lang="ts">
  // #24: built on the bits-ui Tabs primitive (roving focus, arrow keys,
  // role=tablist/tab, aria-selected) instead of hand-rolled buttons.
  import { Tabs } from "bits-ui";

  type Tab = "chat" | "editor";
  interface Props {
    activeTab: Tab;
    onSwitch: (tab: Tab) => void;
  }
  let { activeTab, onSwitch }: Props = $props();
</script>

<Tabs.Root
  value={activeTab}
  onValueChange={(v) => onSwitch(v as Tab)}
  activationMode="automatic"
>
  <Tabs.List class="tab-switcher" aria-label="Workspace">
    <Tabs.Trigger value="chat" class="tab">Chat</Tabs.Trigger>
    <Tabs.Trigger value="editor" class="tab">EdgeCoder</Tabs.Trigger>
  </Tabs.List>
</Tabs.Root>

<style>
  :global(.tab-switcher) {
    display: flex;
    background: var(--bg-surface);
    border-radius: 8px;
    padding: 3px;
    gap: 2px;
  }
  :global(.tab-switcher .tab) {
    padding: 6px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 6px;
    transition: all 0.15s;
  }
  :global(.tab-switcher .tab:hover) {
    color: var(--text-primary);
  }
  :global(.tab-switcher .tab:focus-visible) {
    outline: 2px solid var(--accent, currentColor);
    outline-offset: 1px;
  }
  :global(.tab-switcher .tab[data-state="active"]) {
    background: var(--bg-base);
    color: var(--text-primary);
    font-weight: 600;
  }
</style>
