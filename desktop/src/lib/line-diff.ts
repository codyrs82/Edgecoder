// Line diff for inline edits: which runs of lines a proposed replacement removes and adds, so each
// change can be accepted or rejected on its own. LCS over lines; edits are small (a selection).

export interface LineHunk {
  /** Index of the first removed line in the old text (where the hunk starts when nothing is removed). */
  oldStart: number;
  oldLines: string[];
  /** Index of the first added line in the new text. */
  newStart: number;
  newCount: number;
}

/** Above this many cells the whole region is one hunk (accept/reject as a block). */
const MAX_CELLS = 250_000;

export function diffLines(oldLines: string[], newLines: string[]): LineHunk[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > MAX_CELLS) {
    return n === 0 && m === 0 ? [] : [{ oldStart: 0, oldLines: [...oldLines], newStart: 0, newCount: m }];
  }
  // lcs[i][j] = LCS length of oldLines[i:] and newLines[j:]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  let open: LineHunk | null = null;
  const close = () => {
    if (open && (open.oldLines.length > 0 || open.newCount > 0)) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open ??= { oldStart: i, oldLines: [], newStart: j, newCount: 0 };
      open.newCount++;
      j++;
    } else {
      open ??= { oldStart: i, oldLines: [], newStart: j, newCount: 0 };
      open.oldLines.push(oldLines[i]);
      i++;
    }
  }
  close();
  return hunks;
}
