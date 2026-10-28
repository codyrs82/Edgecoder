<script lang="ts">
  // #24: Cmd/Ctrl+K command palette on bits-ui Dialog + Command
  // (focus trap, Escape to close, combobox/listbox roles, arrow-key navigation, filtering).
  import { Command, Dialog } from "bits-ui";
  import { filterCommands, groupCommands, isMac, isPaletteShortcut, type PaletteCommand } from "../lib/palette";

  interface Props {
    commands: PaletteCommand[];
    open?: boolean;
  }
  let { commands, open = $bindable(false) }: Props = $props();
  let search = $state("");
  const mac = isMac();
  let groups = $derived(groupCommands(filterCommands(groupCommands(commands).flatMap((g) => g.items), search)));

  function onWindowKeydown(e: KeyboardEvent) {
    if (!isPaletteShortcut(e, mac)) return;
    e.preventDefault();
    open = !open;
  }

  function run(cmd: PaletteCommand) {
    open = false;
    search = "";
    // Let the dialog close (and focus return) before the command moves focus elsewhere.
    queueMicrotask(cmd.run);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) search = ""; }}>
  <Dialog.Portal>
    <Dialog.Overlay class="palette-overlay" />
    <Dialog.Content class="palette" aria-describedby={undefined}>
      <Dialog.Title class="sr-only">Command palette</Dialog.Title>
      <Command.Root label="Command palette" loop shouldFilter={false}>
        <Command.Input class="palette-input" placeholder="Type a command…" bind:value={search} />
        <Command.List class="palette-list">
          <Command.Viewport>
            <Command.Empty class="palette-empty">No matching commands</Command.Empty>
            {#each groups as g (g.group)}
              <Command.Group value={g.group}>
                <Command.GroupHeading class="palette-heading">{g.group}</Command.GroupHeading>
                <Command.GroupItems>
                  {#each g.items as cmd (cmd.id)}
                    <Command.Item class="palette-item" value={cmd.id} onSelect={() => run(cmd)}>
                      <span>{cmd.label}</span>
                      {#if cmd.shortcut}<kbd>{cmd.shortcut}</kbd>{/if}
                    </Command.Item>
                  {/each}
                </Command.GroupItems>
              </Command.Group>
            {/each}
          </Command.Viewport>
        </Command.List>
      </Command.Root>
      <p class="palette-hint" aria-hidden="true">{mac ? "⌘" : "Ctrl"}+K to toggle · ↑↓ to move · Enter to run · Esc to close</p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.palette-overlay) { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 900; }
  :global(.palette) {
    position: fixed; top: 14vh; left: 50%; transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px)); max-height: 70vh; display: flex; flex-direction: column;
    background: var(--bg-elevated, #454542); color: var(--text-primary, #f7f5f0);
    border: 1px solid var(--border-strong, rgba(214, 204, 194, 0.15)); border-radius: var(--radius-lg, 10px);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4); z-index: 901; overflow: hidden;
  }
  :global(.palette-input) {
    width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 15px; border: none;
    border-bottom: 1px solid var(--border, rgba(214, 204, 194, 0.08)); background: transparent; color: inherit; outline: none;
  }
  :global(.palette-list) { overflow-y: auto; padding: 6px; }
  :global(.palette-heading) { padding: 8px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary, #b8b0a4); }
  :global(.palette-item) {
    display: flex; justify-content: space-between; align-items: center; padding: 8px 10px;
    border-radius: var(--radius-sm, 6px); cursor: pointer; font-size: 14px;
  }
  :global(.palette-item[data-selected]) { background: var(--accent, #c17850); color: var(--on-accent, #1a1a18); }
  :global(.palette-item kbd) { font-family: var(--font-mono, monospace); font-size: 11px; opacity: 0.75; }
  :global(.palette-empty) { padding: 16px; text-align: center; color: var(--text-secondary, #b8b0a4); font-size: 13px; }
  .palette-hint { margin: 0; padding: 8px 14px; font-size: 11px; color: var(--text-secondary, #b8b0a4); border-top: 1px solid var(--border, rgba(214, 204, 194, 0.08)); }
  :global(.sr-only) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
