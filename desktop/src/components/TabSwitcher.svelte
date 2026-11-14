<script lang="ts">
  // #24: the Chat / EdgeCoder switch on bits-ui Tabs (arrow keys, roving tabindex, aria-selected).
  // Both views stay mounted in App.svelte, outside this component, so each tab names its panel by
  // id instead of rendering a Tabs.Content.
  import { Tabs } from "bits-ui";

  type View = "chat" | "editor";
  interface Props {
    activeTab: View;
    onSwitch: (tab: View) => void;
  }
  let { activeTab, onSwitch }: Props = $props();

  const VIEWS: { id: View; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "editor", label: "EdgeCoder" },
  ];
</script>

<Tabs.Root class="contents" value={activeTab} onValueChange={(v) => onSwitch(v as View)}>
  <Tabs.List aria-label="View">
    {#snippet child({ props })}
      <div {...props} class="tab-switcher">
        {#each VIEWS as view (view.id)}
          <Tabs.Trigger value={view.id} id="view-tab-{view.id}">
            {#snippet child({ props })}
              <button {...props} class="tab" aria-controls="view-{view.id}">{view.label}</button>
            {/snippet}
          </Tabs.Trigger>
        {/each}
      </div>
    {/snippet}
  </Tabs.List>
</Tabs.Root>

<style>
  .tab-switcher {
    display: flex;
    background: var(--bg-surface);
    border-radius: var(--radius-md);
    padding: 3px;
    gap: 2px;
  }
  .tab {
    padding: 6px 16px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: all 0.15s;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab[data-state="active"] {
    background: var(--bg-base);
    color: var(--text-primary);
    font-weight: 600;
  }
</style>
