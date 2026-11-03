<script lang="ts">
  import "../../src/app.css";
  import ConversationSidebar from "../../src/components/ConversationSidebar.svelte";
  import ChatInput from "../../src/components/ChatInput.svelte";
  import ComputePicker from "../../src/components/ComputePicker.svelte";
  import SettingsOverlay from "../../src/components/SettingsOverlay.svelte";
  import { computeChoice } from "../../src/lib/compute-choice";

  let { settings }: { settings?: string } = $props();
  const user = { userId: "u1", email: "cody@example.com", displayName: "Cody Smith", emailVerified: true };
  let open = $state(settings !== undefined);
  let section = $state(settings || undefined);
</script>

<div style="display:flex;height:100%">
  <div style="width:260px;border-right:0.5px solid var(--border);display:flex;flex-direction:column">
    <ConversationSidebar open={true} inline={true} onClose={() => {}} onSelectConversation={() => {}} onNewChat={() => {}} activeConversationId={null}
      {user} onOpenSettings={(s) => { section = s; open = true; }} onLogout={() => {}} />
  </div>
  <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding:16px 20px">
    <div style="width:100%;max-width:820px">
      <ChatInput onSend={() => {}}>
        {#snippet toolbar()}
          <ComputePicker selected={$computeChoice} onSelect={(id) => computeChoice.set(id)} onOpenSettings={(s) => { section = s; open = true; }} />
        {/snippet}
      </ChatInput>
    </div>
  </div>
</div>
{#if open}
  <SettingsOverlay onClose={() => (open = false)} {user} onLogout={() => {}} initialSection={section} />
{/if}
