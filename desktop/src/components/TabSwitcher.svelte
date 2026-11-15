<script lang="ts">
  // #24: the Chat / EdgeCoder switch on bits-ui Tabs (arrow keys, roving tabindex, aria-selected).
  // Both views stay mounted in App.svelte, outside this component, so each tab names its panel by
  // id instead of rendering a Tabs.Content.
  import { Tabs } from "bits-ui";
  import { MessageSquare, Code } from "@lucide/svelte";

  type View = "chat" | "editor";
  interface Props {
    activeTab: View;
    onSwitch: (tab: View) => void;
  }
  let { activeTab, onSwitch }: Props = $props();

  const VIEWS: { id: View; label: string; icon: typeof Code }[] = [
    { id: "chat", label: "Chat", icon: MessageSquare },
    { id: "editor", label: "Code", icon: Code },
  ];
</script>

<Tabs.Root class="contents" value={activeTab} onValueChange={(v) => onSwitch(v as View)}>
  <Tabs.List aria-label="View">
    {#snippet child({ props })}
      <div {...props} class="tab-switcher view-switch">
        {#each VIEWS as view (view.id)}
          <Tabs.Trigger value={view.id} id="view-tab-{view.id}">
            {#snippet child({ props })}
              <button {...props} class="tab" aria-controls="view-{view.id}"><view.icon size={14} aria-hidden="true" />{view.label}</button>
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
    height: var(--control-md);
    padding: 2px;
    gap: 2px;
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: background-color .12s, color .12s;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab[data-state="active"] {
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }
</style>
