// Per-project chat preferences, and recognising "build me something" requests that should start
// a new project when none is open.

const AUTO_APPLY = "edgecoder-autoapply:";

/** Whether the agent applies file edits without asking in this project (commands always ask). */
export function autoApplyEdits(projectRoot: string | null): boolean {
  if (!projectRoot) return false;
  try {
    return localStorage.getItem(AUTO_APPLY + projectRoot) === "on";
  } catch {
    return false;
  }
}

export function setAutoApplyEdits(projectRoot: string, on: boolean): void {
  try {
    localStorage.setItem(AUTO_APPLY + projectRoot, on ? "on" : "off");
  } catch {
    // storage unavailable: lasts for this session only
  }
}

const BUILD = /\b(build|create|make|write|code|generate|scaffold|start|develop|design)\b/i;
const THING = /\b(app|apps|application|website|web ?page|webpage|site|page|landing|game|script|program|project|api|server|backend|frontend|cli|tool|component|dashboard|bot|extension|plugin|portfolio|blog|calculator|todo|clone|ui|form|library|service)\b/i;

/** "Let's build a new webpage", "make a snake game in JS"... but not "how do I build Rust?". */
export function isBuildRequest(text: string): boolean {
  const t = text.trim();
  if (t.length > 2000) return false;
  if (/^(how|why|what|when|where|which|who|is|are|does|do|can i|should)\b/i.test(t) && t.endsWith("?")) return false;
  return BUILD.test(t) && THING.test(t);
}
