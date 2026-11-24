// A conversation's scroll position (EditorChatPanel, ChatView, LiveSessionPanel). Opening a chat
// shows its latest messages, also when they load later or images and code blocks grow afterwards.
// While a reply streams the view stays at the bottom only if the reader was there (within 80 px);
// someone who scrolled up to read is left where they are, and the "Jump to latest" button shows
// (with a dot when something new arrived meanwhile).

/** Within this many pixels of the bottom counts as at the bottom. */
export const NEAR_BOTTOM = 80;

export interface FollowState {
  /** At (or near) the bottom: new content keeps it there. */
  atBottom: boolean;
  /** Something new arrived while scrolled up. */
  unseen: boolean;
}

export function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

const frame = (fn: () => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number);

export interface Follower {
  /** The Svelte action for the scroll container (`use:follower.action`). */
  action: (node: HTMLElement) => { destroy: () => void };
  /** A conversation was opened or switched to: go to its bottom and stay there while it renders. */
  reset: () => void;
  /** New content (a message, a streamed chunk): follow it when at the bottom, else mark it unseen. */
  contentChanged: () => void;
  /** The "Jump to latest" button: scroll smoothly to the bottom and follow from there. */
  jump: () => void;
}

export function createFollower(onChange: (s: FollowState) => void): Follower {
  let node: HTMLElement | null = null;
  let pinned = true;
  let unseen = false;
  let lastTop = 0;
  let lastHeight = 0;
  let pending = 0;
  // Frames left in which a pinned view is put back at the bottom (a chat still loading and laying out).
  let settle = 0;
  let reported: FollowState | null = null;

  const report = () => {
    const s = { atBottom: pinned, unseen };
    if (reported && reported.atBottom === s.atBottom && reported.unseen === s.unseen) return;
    reported = s;
    onChange(s);
  };
  const toBottom = (smooth = false) => {
    if (!node) return;
    if (smooth && typeof node.scrollTo === "function") node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    else {
      node.scrollTop = node.scrollHeight;
      // Our own move is not the reader scrolling (a smooth one only ever moves down).
      lastTop = node.scrollTop;
    }
    lastHeight = node.scrollHeight;
  };
  const schedule = () => {
    if (pending) return;
    pending = frame(() => {
      pending = 0;
      if (!pinned) return;
      toBottom();
      if (settle > 0) {
        settle--;
        schedule();
      }
    });
  };
  const onScroll = () => {
    if (!node) return;
    const top = node.scrollTop;
    const movedUp = top < lastTop - 1;
    lastTop = top;
    if (distanceFromBottom(node) <= NEAR_BOTTOM) {
      pinned = true;
      unseen = false;
    } else if (movedUp) {
      // The reader scrolled up (a smooth jump only ever moves down): stop following.
      pinned = false;
      settle = 0;
    }
    report();
  };
  const onGrow = () => {
    if (!node || node.scrollHeight === lastHeight) return;
    if (pinned) schedule();
    else lastHeight = node.scrollHeight;
  };

  return {
    action(el: HTMLElement) {
      node = el;
      lastTop = el.scrollTop;
      lastHeight = el.scrollHeight;
      el.addEventListener("scroll", onScroll, { passive: true });
      // Images (and other media) finishing loading change the height without a DOM change.
      el.addEventListener("load", onGrow, true);
      const mo = typeof MutationObserver === "function" ? new MutationObserver(onGrow) : null;
      mo?.observe(el, { childList: true, subtree: true, characterData: true });
      const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onGrow) : null;
      ro?.observe(el);
      if (pinned) schedule();
      return {
        destroy() {
          el.removeEventListener("scroll", onScroll);
          el.removeEventListener("load", onGrow, true);
          mo?.disconnect();
          ro?.disconnect();
          if (node === el) node = null;
        },
      };
    },
    reset() {
      pinned = true;
      unseen = false;
      settle = 4;
      toBottom();
      schedule();
      report();
    },
    contentChanged() {
      if (pinned) schedule();
      else if (!unseen) {
        unseen = true;
        report();
      }
    },
    jump() {
      pinned = true;
      unseen = false;
      toBottom(true);
      report();
    },
  };
}
