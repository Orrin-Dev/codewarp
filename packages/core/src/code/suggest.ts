/** Loose matching for the autocomplete popup and "did you mean" messages. */

const norm = (s: string): string => s.toLowerCase().replace(/[_\s]/g, '');

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = keep;
    }
  }
  return prev[b.length];
}

/** How well `query` matches `name`: 0 means not at all, bigger is better. Typos are forgiven. */
export function matchScore(query: string, name: string): number {
  const q = norm(query);
  const n = norm(name);
  if (!q) return 1;
  if (n === q) return 100;
  if (n.startsWith(q)) return 90;
  const at = n.indexOf(q);
  if (at >= 0) return 70 - Math.min(20, at);
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = n.indexOf(ch, pos + 1);
    if (next < 0) {
      pos = -2;
      break;
    }
    gaps += next - pos - 1;
    pos = next;
  }
  if (pos >= 0 && q.length >= 2) return Math.max(30, 55 - gaps);
  if (q.length >= 3) {
    // a typo: compare with the same number of leading letters, or the whole name
    const d = Math.min(editDistance(q, n), editDistance(q, n.slice(0, q.length)));
    if (d <= (q.length >= 4 ? 2 : 1)) return 40 - d * 5;
  }
  return 0;
}

/** The closest name to a misspelt one, or null when nothing is close. */
export function closest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = matchScore(name, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= 30 ? best : null;
}
