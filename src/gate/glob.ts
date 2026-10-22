// Comprende's glob rules for the `sensitive` and `ignore` lists.

/**
 * Comprende's glob rules, for the `sensitive` and `ignore` lists. A pattern
 * matches the whole path:
 * - `*` matches any run of characters, including "/" (so `**` is the same as `*`);
 * - `?` matches exactly one character, counted in code points (one emoji);
 * - `[abc]` and `[a-z]` match one character of the set, and `[!...]` negates it;
 *   a `]` right after `[` or `[!` is a member, not the end;
 * - a reversed range such as `[z-a]` is empty: it's dropped from the set, so
 *   a set of only empty ranges matches nothing (`[!z-a]` matches any one
 *   character). Never an error. Ranges compare code points;
 * - a `[` without a closing `]` is a literal "[";
 * - every other character matches itself.
 * `matches()` also lets a leading `**` + `/` match at the repo root.
 */
function globToRegExp(pat: string): RegExp {
  const chars = [...pat]; // code points, so "?" matches one emoji, not half of one
  const n = chars.length;
  const res: string[] = [];
  const escapeOutside = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const escapeInSet = (c: string) => c.replace(/[\\\]\[^-]/g, "\\$&");
  let i = 0;
  while (i < n) {
    const c = chars[i++];
    if (c === "*") {
      if (res[res.length - 1] !== "[\\s\\S]*") res.push("[\\s\\S]*");
    } else if (c === "?") res.push("[\\s\\S]");
    else if (c === "[") {
      let j = i;
      if (j < n && chars[j] === "!") j++;
      if (j < n && chars[j] === "]") j++;
      while (j < n && chars[j] !== "]") j++;
      if (j >= n) {
        res.push("\\[");
        continue;
      }
      const negate = chars[i] === "!";
      const body = chars.slice(negate ? i + 1 : i, j);
      i = j + 1;
      // Split into single characters and lo-hi ranges.
      const items: [string, string][] = [];
      for (let k = 0; k < body.length; k++) {
        if (k + 2 < body.length && body[k + 1] === "-") {
          items.push([body[k], body[k + 2]]);
          k += 2;
        } else items.push([body[k], body[k]]);
      }
      // Drop empty (reversed) ranges. Compare code points: in UTF-16 order,
      // U+E000–U+FFFF would sort after every emoji.
      const valid = items.filter(([lo, hi]) => lo.codePointAt(0)! <= hi.codePointAt(0)!);
      if (!valid.length) {
        res.push(negate ? "[\\s\\S]" : "(?!)");
        continue;
      }
      const cls = valid.map(([lo, hi]) => (lo === hi ? escapeInSet(lo) : `${escapeInSet(lo)}-${escapeInSet(hi)}`)).join("");
      res.push(negate ? `[^${cls}]` : `[${cls}]`);
    } else res.push(escapeOutside(c));
  }
  return new RegExp(`^(?:${res.join("")})$`, "u");
}

const globCache = new Map<string, RegExp>();

export const globMatch = (path: string, pat: string): boolean => {
  let re = globCache.get(pat);
  if (!re) globCache.set(pat, (re = globToRegExp(pat)));
  return re.test(path);
};

export function matches(path: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (globMatch(path, pat)) return true;
    // Let "**/x/**" also match "x/..." at the repo root.
    if (pat.startsWith("**/") && globMatch(path, pat.slice(3))) return true;
  }
  return false;
}
