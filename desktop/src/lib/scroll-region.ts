/**
 * A box that overflows can only be scrolled from the keyboard if it takes focus, and a box
 * that fits should not be a tab stop: tabindex follows whether the content overflows right now.
 */
export function scrollRegion(node: HTMLElement) {
  const sync = () => {
    const overflows = node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1;
    if (overflows) node.tabIndex = 0;
    else node.removeAttribute("tabindex");
  };
  sync();
  // jsdom has no layout and no ResizeObserver; there is nothing to track there.
  if (typeof ResizeObserver === "undefined") return {};
  const observer = new ResizeObserver(sync);
  observer.observe(node);
  // The content growing (rows added) changes the overflow without resizing the box itself.
  for (const child of Array.from(node.children)) observer.observe(child);
  return { destroy: () => observer.disconnect() };
}
