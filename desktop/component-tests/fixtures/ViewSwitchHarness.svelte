<script lang="ts">
  // The Chat / Code switch placed the way App.svelte places it: above New chat in the open view's
  // sidebar, in the title bar while that sidebar is hidden (lib/view-switch.ts).
  import TabSwitcher from "../../src/components/TabSwitcher.svelte";
  import ConversationSidebar from "../../src/components/ConversationSidebar.svelte";
  import ProjectSidebar from "../../src/components/ProjectSidebar.svelte";
  import { viewSwitchSpot, type View } from "../../src/lib/view-switch";
  import type { SessionSummary } from "../../src/lib/api";

  interface Props { view?: View; chatOpen?: boolean; codeOpen?: boolean; liveSessions?: SessionSummary[] }
  let { view = "chat", chatOpen = true, codeOpen = true, liveSessions = [] }: Props = $props();
  let active = $state<View>("chat");
  $effect.pre(() => { active = view; });
  const spot = $derived(viewSwitchSpot(active, chatOpen, codeOpen));
  const noop = () => {};
</script>

{#snippet viewSwitch()}
  <div class="sidebar-switch" data-testid="sidebar-switch"><TabSwitcher activeTab={active} onSwitch={(t) => (active = t)} /></div>
{/snippet}

<header data-testid="titlebar" data-tauri-drag-region>
  {#if spot === "titlebar"}<TabSwitcher activeTab={active} onSwitch={(t) => (active = t)} />{/if}
</header>
<div data-testid="chat-side" hidden={active !== "chat"}>
  <ConversationSidebar open inline onClose={noop} onSelectConversation={noop} onNewChat={noop} activeConversationId={null} top={spot === "chat-sidebar" ? viewSwitch : undefined} />
</div>
<div data-testid="code-side" hidden={active !== "editor"}>
  <ProjectSidebar currentProject={null} activeChatId={null} onOpenProject={noop} onSelectChat={noop} onNewChat={noop} onNewProject={noop} onOpenFolder={noop} onClone={noop} {liveSessions} top={spot === "code-sidebar" ? viewSwitch : undefined} />
</div>
<div role="tabpanel" id="view-chat" aria-labelledby="view-tab-chat"></div>
<div role="tabpanel" id="view-editor" aria-labelledby="view-tab-editor"></div>
