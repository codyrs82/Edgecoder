<script lang="ts">
  interface Props {
    activeTab: "chat" | "editor";
    onSwitch: (tab: "chat" | "editor") => void;
  }
  let { activeTab, onSwitch }: Props = $props();
</script>

<div class="tab-switcher">
  <button
    class="tab {activeTab === 'chat' ? 'active' : ''}"
    onclick={() => onSwitch("chat")}
  >Chat</button>
  <button
    class="tab {activeTab === 'editor' ? 'active' : ''}"
    onclick={() => onSwitch("editor")}
  >EdgeCoder</button>
</div>

<style>
  .tab-switcher {
    display: flex;
    background: var(--bg-surface);
    border-radius: 8px;
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
    border-radius: 6px;
    transition: all 0.15s;
  }
  .tab:hover {
    color: var(--text-primary);
  }
  .tab.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 600;
  }
</style>
