<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import "@xterm/xterm/css/xterm.css";
  import tokens from "@edgecoder/tokens/tokens.json";

  interface Props {
    /** Folder the shell starts in (the open project). */
    cwd: string | null;
  }
  let { cwd }: Props = $props();

  let host: HTMLDivElement | undefined = $state(undefined);
  let exited = $state(false);
  let error = $state<string | null>(null);
  let term: any = null;
  let fit: any = null;
  let id: number | null = null;
  /** Folder the running shell was started in. */
  let startedIn: string | null = null;
  const unlisten: Array<() => void> = [];
  let resizeObserver: ResizeObserver | undefined;

  function cssVar(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function start() {
    const { invoke } = await import("@tauri-apps/api/core");
    exited = false;
    error = null;
    fit?.fit();
    try {
      startedIn = cwd;
      id = await invoke<number>("term_spawn", { cwd, cols: term.cols, rows: term.rows });
    } catch (e) {
      error = String(e);
    }
  }

  onMount(async () => {
    const { Terminal } = await import("@xterm/xterm");
    const { FitAddon } = await import("@xterm/addon-fit");
    const { listen } = await import("@tauri-apps/api/event");
    const { invoke } = await import("@tauri-apps/api/core");
    term = new Terminal({
      fontFamily: tokens.font.mono,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: cssVar("--bg-base", "#0d1117"),
        foreground: cssVar("--text-primary", "#e6edf3"),
        cursor: cssVar("--accent", "#e8963b"),
        selectionBackground: "rgba(232, 150, 59, 0.3)",
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    if (!host) return;
    term.open(host);
    fit.fit();
    unlisten.push(await listen<{ id: number; data: string }>("term-data", (e) => {
      if (e.payload.id === id) term.write(b64ToBytes(e.payload.data));
    }));
    unlisten.push(await listen<{ id: number }>("term-exit", (e) => {
      if (e.payload.id !== id) return;
      exited = true;
      id = null;
      term.write("\r\n\x1b[2m[shell exited, press Enter to restart]\x1b[0m\r\n");
    }));
    term.onData((data: string) => {
      if (exited) {
        if (data === "\r") void start();
        return;
      }
      if (id !== null) void invoke("term_write", { id, data });
    });
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (id !== null) void invoke("term_resize", { id, cols, rows });
    });
    resizeObserver = new ResizeObserver(() => {
      // Hidden panels measure as zero; fit only when visible.
      if (host && host.offsetParent) fit.fit();
    });
    resizeObserver.observe(host);
    await start();
  });

  onDestroy(async () => {
    resizeObserver?.disconnect();
    for (const u of unlisten) u();
    if (id !== null) {
      const { invoke } = await import("@tauri-apps/api/core");
      void invoke("term_kill", { id });
    }
    term?.dispose();
  });

  // A different project: end the old shell and start one in the new folder.
  $effect(() => {
    const dir = cwd;
    if (!term || dir === startedIn) return;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const old = id;
      id = null;
      if (old !== null) await invoke("term_kill", { id: old });
      term.write(`\r\n\x1b[2m[project changed: new shell in ${dir ?? "home"}]\x1b[0m\r\n`);
      await start();
    })();
  });

  /** Focus the terminal (after the panel is shown). */
  export function focus() {
    fit?.fit();
    term?.focus();
  }
</script>

<div class="terminal-wrap">
  {#if error}<div class="error">Couldn't start a terminal: {error}</div>{/if}
  <div class="xterm-host" bind:this={host}></div>
</div>

<style>
  .terminal-wrap {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }
  .xterm-host {
    flex: 1;
    min-height: 0;
    padding: 4px 0 0 8px;
  }
  .error {
    padding: 6px 10px;
    font-size: 12px;
    color: var(--danger, #f85149);
  }
</style>
