import type { LineDiffLine } from "../../api/types";

// Collapses long unchanged stretches so a big diff stays readable.
const DIFF_CONTEXT_LINES = 12;

export type DiffSegment =
  | { kind: "line"; index: number; line: LineDiffLine }
  | { kind: "collapsed"; id: string; startIndex: number; endIndex: number; count: number };

export function buildDiffSegments(lines: LineDiffLine[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type !== "unchanged") {
      segments.push({ kind: "line", index: i, line: lines[i] });
      i++;
      continue;
    }

    let j = i;
    while (j < lines.length && lines[j].type === "unchanged") j++;
    const runLength = j - i;
    const leadContext = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const trailContext = j === lines.length ? 0 : DIFF_CONTEXT_LINES;
    const hiddenCount = runLength - leadContext - trailContext;

    if (hiddenCount <= 0) {
      for (let k = i; k < j; k++) segments.push({ kind: "line", index: k, line: lines[k] });
    } else {
      for (let k = i; k < i + leadContext; k++) segments.push({ kind: "line", index: k, line: lines[k] });
      segments.push({
        kind: "collapsed",
        id: `${i + leadContext}-${j - trailContext}`,
        startIndex: i + leadContext,
        endIndex: j - trailContext,
        count: hiddenCount,
      });
      for (let k = j - trailContext; k < j; k++) segments.push({ kind: "line", index: k, line: lines[k] });
    }
    i = j;
  }

  return segments;
}
