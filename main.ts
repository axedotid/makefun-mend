// mend: one CLI that applies four AI edit formats to a tree of text files (MIT).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// Formats: unified diff, SEARCH/REPLACE blocks, V4A patch, JSON editor calls.
// Every file changes or none does (atomicity).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// (oldPath, newPath) pairs recorded by move edits, for R rename rows.
let moves: [string, string][] = [];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

// ---------- shared line helpers ----------

interface FileShape {
  br: string;
  lines: string[];
  final: boolean;
}

function shape(text: string): FileShape {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function render(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

type Tier = 0 | 1 | 2;

function matchAt(fileLines: string[], fileIdx: number, old: string[], tier: Tier): boolean {
  for (let k = 0; k < old.length; k += 1) {
    const f = fileLines[fileIdx + k];
    const o = old[k]!;
    if (f === undefined) return false;
    if (tier === 0) {
      if (f !== o) return false;
    } else if (tier === 1) {
      if (f.replace(/[ \t]+$/, '') !== o.replace(/[ \t]+$/, '')) return false;
    } else if (f.trim() !== o.trim()) return false;
  }
  return true;
}

/** The tier at which O actually occurs at fileIdx (0, 1, 2, or -1), exact-first. */
function tierAt(fileLines: string[], fileIdx: number, old: string[], strict: boolean): Tier | -1 {
  const maxTier: Tier = strict ? 0 : 2;
  for (let t = 0 as Tier; t <= maxTier; t = (t + 1) as Tier) {
    if (matchAt(fileLines, fileIdx, old, t)) return t;
  }
  return -1;
}

function occurrences(fileLines: string[], old: string[], tier: Tier): number[] {
  const res: number[] = [];
  if (old.length === 0) return res;
  for (let i = 0; i + old.length <= fileLines.length; i += 1) {
    if (matchAt(fileLines, i, old, tier)) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, with its occurrences. */
function findTier(fileLines: string[], old: string[], strict: boolean): { tiers: Tier[]; occ: number[] } | null {
  if (old.length === 0) return { tiers: [], occ: [] };
  const maxTier: Tier = strict ? 0 : 2;
  for (let t = 0 as Tier; t <= maxTier; t = (t + 1) as Tier) {
    const occ = occurrences(fileLines, old, t);
    if (occ.length > 0) return { tiers: occ.map(() => t), occ };
  }
  return null;
}

/** First line index at or after `from` whose single line matches `line` at the first tier with one. */
function findAnchor(lines: string[], from: number, line: string, strict: boolean): number {
  const maxTier: Tier = strict ? 0 : 2;
  for (let t = 0 as Tier; t <= maxTier; t = (t + 1) as Tier) {
    for (let i = from; i < lines.length; i += 1) {
      if (matchAt(lines, i, [line], t)) return i;
    }
  }
  return -1;
}

/** Re-indent the non-context new lines from O's lead to the file's matched lead (tier 2). */
function reindent(N: string[], O: string[], contextIdx: Set<number>, fileLead: string): string[] {
  const P = leadOf(O[0] ?? '');
  return N.map((ln, k) => {
    if (contextIdx.has(k)) return ln;
    if (ln !== '' && ln.trim() !== '' && ln.startsWith(P)) return fileLead + ln.slice(P.length);
    return ln;
  });
}

// ---------- unified diff (section 6) ----------

interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  noNl: boolean;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UHunk[];
}

function hunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { a: parseInt(m[1]!, 10) };
}

function pathFromHeader(s: string): string {
  let p = s.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function stripGit(line: string): { x: string; y: string } | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  if (!m) return null;
  return { x: m[1]!, y: m[2]! };
}

function applyHunks(
  lines: string[],
  br: string,
  final: boolean,
  hunks: UHunk[],
  strict: boolean,
  creating = false,
): string {
  let result = lines.slice();
  let finalNl = final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: string[] = [];
    const ctxIdx = new Set<number>();
    const ctxOIdx: number[] = [];
    for (const bl of h.body) {
      if (bl.kind === 'ctx') {
        ctxIdx.add(N.length);
        ctxOIdx.push(O.length);
        O.push(bl.text);
        N.push(bl.text);
      } else if (bl.kind === 'old') O.push(bl.text);
      else if (bl.kind === 'new') N.push(bl.text);
    }
    const found = findTier(result, O, strict);
    if (found === null) throw new Fail('no-match', '');
    let out: string[];
    let endsAtEnd: boolean;
    if (O.length > 0) {
      const occ = found.occ;
      const target = h.a - 1 + d;
      let bi = 0;
      for (let k = 1; k < occ.length; k += 1) {
        if (Math.abs(occ[k]! - target) < Math.abs(occ[bi]! - target)) bi = k;
      }
      const best = occ[bi]!;
      const bestTier = found.tiers[bi]!;
      // N is rebuilt from the file's own lines: a context line is written as the
      // file's own matched line (in body order), never the patch's.
      const Fn: string[] = [];
      let oi = 0;
      for (let k = 0; k < N.length; k += 1) {
        if (ctxIdx.has(k)) {
          Fn.push(result[best + ctxOIdx[oi]!]!);
          oi += 1;
        } else if (bestTier === 2) {
          const P = leadOf(O[0] ?? '');
          const ln = N[k]!;
          const F = leadOf(result[best]!);
          Fn.push(ln !== '' && ln.trim() !== '' && ln.startsWith(P) ? F + ln.slice(P.length) : ln);
        } else {
          Fn.push(N[k]!);
        }
      }
      out = result.slice(0, best).concat(Fn, result.slice(best + O.length));
      endsAtEnd = best + O.length === result.length;
      d += N.length - O.length;
    } else {
      const at = Math.min(Math.max(h.a + d, 0), result.length);
      const Fn = N;
      out = result.slice(0, at).concat(Fn, result.slice(at));
      endsAtEnd = at === result.length;
      d += N.length;
    }
    // final-newline: a `\` line after the last ctx/new line of the hunk means no trailing newline
    const lastReal = [...h.body].reverse().find((b) => b.kind === 'ctx' || b.kind === 'new');
    let suppress = false;
    if (lastReal) {
      const idx = h.body.indexOf(lastReal);
      const after = h.body[idx + 1];
      if (after && after.kind === 'bs' && after.noNl) suppress = true;
    }
    if (endsAtEnd) finalNl = !suppress;
    result = out;
  }
  if (creating) return render(br, result, finalNl);
  return render(br, result, finalNl);
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  const n = lines.length;
  let seenSection = false;
  while (i < n) {
    const line = lines[i]!;
    const isDiff = line.startsWith('diff --git ');
    const isHeader = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (isDiff) {
      const g = stripGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
      const s = sections[sections.length - 1]!;
      s.oldPath = g.x;
      s.newPath = g.y;
      seenSection = true;
      i += 1;
      continue;
    }
    if (isHeader) {
      const prev = sections[sections.length - 1];
      if (!seenSection || (prev && prev.hunks.length > 0)) {
        sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
        seenSection = true;
      }
      const s = sections[sections.length - 1]!;
      const oldP = pathFromHeader(line);
      const newP = pathFromHeader(lines[i + 1]!);
      if (oldP === '/dev/null' || oldP === 'dev/null') {
        s.oldPath = null;
        s.create = true;
      } else s.oldPath = oldP;
      if (newP === '/dev/null' || newP === 'dev/null') {
        s.newPath = null;
        s.del = true;
      } else s.newPath = newP;
      i += 2;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (sections.length === 0) {
        sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
        seenSection = true;
      }
      sections[sections.length - 1]!.oldPath = line.slice(12).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (sections.length === 0) {
        sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
        seenSection = true;
      }
      sections[sections.length - 1]!.newPath = line.slice(10).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (sections.length === 0) {
        sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
        seenSection = true;
      }
      sections[sections.length - 1]!.create = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (sections.length === 0) {
        sections.push({ oldPath: null, newPath: null, create: false, del: false, hunks: [] });
        seenSection = true;
      }
      sections[sections.length - 1]!.del = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const h = hunkHeader(line);
      if (h === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sections.length === 0) throw new Exit2(`error: parse ${i + 1}`);
      const s = sections[sections.length - 1]!;
      const body: UBodyLine[] = [];
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '', noNl: false });
          i += 1;
        } else if (bl[0] === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1), noNl: false });
          i += 1;
        } else if (bl[0] === '-') {
          body.push({ kind: 'old', text: bl.slice(1), noNl: false });
          i += 1;
        } else if (bl[0] === '+') {
          body.push({ kind: 'new', text: bl.slice(1), noNl: false });
          i += 1;
        } else if (bl[0] === '\\') {
          body.push({ kind: 'bs', text: '', noNl: true });
          i += 1;
        } else break;
      }
      // empty lines at the end of a body are not part of it
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      s.hunks.push({ a: h.a, body });
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree, strict: boolean) => {
    // safety first
    for (const p of [s.oldPath, s.newPath]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (s.create) {
      const np = s.newPath ?? s.oldPath;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      const text = render('\n', plus, true);
      tree.now.set(np, text);
      return;
    }
    if (s.del) {
      const op = s.oldPath ?? s.newPath;
      if (op === null) throw new Fail('unsafe', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = s.oldPath;
    const np = s.newPath;
    if (op === null) throw new Fail('unsafe', '');
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const sh = shape(before);
    let out: string;
    try {
      out = applyHunks(sh.lines, sh.br, sh.final, s.hunks, strict);
    } catch (e) {
      if (e instanceof Fail) throw new Fail(e.code, op);
      throw e;
    }
    const moving = np !== null && np !== op;
    if (moving) {
      if (tree.get(np!) !== null) throw new Fail('exists', np!);
      tree.now.set(np!, out);
      tree.now.set(op, null);
      moves.push([op, np!]);
    } else {
      tree.now.set(op, out);
    }
  });
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

interface SRBlock {
  path: string | null;
  old: string[];
  neu: string[];
}

function srEdits(lines: string[]): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  const n = lines.length;
  let prevPath: string | null = null;
  let afterReplace = -1;
  while (i < n) {
    if (lines[i]!.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      // find path: nearest non-blank, non-backtick line before SEARCH and after previous REPLACE
      let path: string | null = null;
      for (let j = i - 1; j >= 0 && j > afterReplace; j -= 1) {
        const t = lines[j]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      // find ======= then >>>>>>> REPLACE
      let sep = -1;
      for (let j = i + 1; j < n; j += 1) {
        if (lines[j]!.replace(/[ \t]+$/, '') === '=======') {
          sep = j;
          break;
        }
      }
      if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
      let end = -1;
      for (let j = sep + 1; j < n; j += 1) {
        if (lines[j]!.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, sep);
      const newLines = lines.slice(sep + 1, end);
      blocks.push({ path, old: oldLines, neu: newLines });
      prevPath = path;
      afterReplace = end;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');

  return blocks.map((b) => (tree: Tree, strict: boolean) => {
    const p = b.path!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, render('\n', b.neu.slice(), true));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const sh = shape(before);
    const found = findTier(sh.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length !== 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const bestTier = found.tiers[0]!;
    const Fn = bestTier === 2 ? reindent(b.neu, b.old, new Set(), leadOf(sh.lines[at]!)) : b.neu;
    const outLines = sh.lines.slice(0, at).concat(Fn, sh.lines.slice(at + b.old.length));
    tree.now.set(p, render(sh.br, outLines, sh.final));
  });
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null; // null = no anchor; '' handled as no anchor
  eof: boolean;
  body: UBodyLine[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lines: string[]; // add
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[]): Edit[] {
  const n = lines.length;
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (!blank(lines[i]!)) { lastIdx = i; break; }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const sections: VSection[] = [];
  let i = firstIdx + 1;
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  let inBody = false;

  const closeChunk = (): void => {
    if (chunk && cur) cur.chunks.push(chunk);
    chunk = null;
    inBody = false;
  };

  while (i < lastIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      if (cur && cur.kind === 'add') {
        cur.lines.push('');
        i += 1;
        continue;
      }
      // blank lines between sections ignored; inside a body an empty context line
      if (cur && chunk && inBody) {
        chunk.body.push({ kind: 'ctx', text: '', noNl: false });
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      closeChunk();
      cur = { kind: 'add', path: line.slice(13).trim(), lines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closeChunk();
      cur = { kind: 'del', path: line.slice(17).trim(), lines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closeChunk();
      cur = { kind: 'upd', path: line.slice(17).trim(), lines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (!cur || cur.kind !== 'upd' || cur.chunks.length > 0 || chunk !== null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      cur.moveTo = line.slice(13).trim();
      i += 1;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (!cur || cur.kind !== 'upd' || !chunk) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      closeChunk();
      i += 1;
      continue;
    }
    if (!cur) throw new Exit2(`error: parse ${i + 1}`);
    if (cur.kind === 'add') {
      if (line[0] === '+') cur.lines.push(line.slice(1));
      else if (line === '') cur.lines.push('');
      else throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // (blank lines inside an Add File body are handled above as empty file lines)
    if (cur.kind === 'del') throw new Exit2(`error: parse ${i + 1}`);
    // update section
    if (line.startsWith('@@')) {
      closeChunk();
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      inBody = false;
      i += 1;
      continue;
    }
    // body line
    if (!chunk) {
      // first chunk can start at a body line
      chunk = { anchor: null, eof: false, body: [] };
    }
    inBody = true;
    if (line === '') chunk.body.push({ kind: 'ctx', text: '', noNl: false });
    else if (line[0] === ' ') chunk.body.push({ kind: 'ctx', text: line.slice(1), noNl: false });
    else if (line[0] === '-') chunk.body.push({ kind: 'old', text: line.slice(1), noNl: false });
    else if (line[0] === '+') chunk.body.push({ kind: 'new', text: line.slice(1), noNl: false });
    else throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  closeChunk();

  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) {
      // find the Update File line number
      const idx = lines.findIndex((l) => l === `*** Update File: ${s.path}`);
      throw new Exit2(`error: parse ${idx + 1}`);
    }
  }

  return sections.map((s) => (tree: Tree, strict: boolean) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, render('\n', s.lines.slice(), true));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // update
    // trailing empty context lines are not part of a chunk
    for (const c of s.chunks) {
      while (c.body.length > 0) {
        const last = c.body[c.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') c.body.pop();
        else break;
      }
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    const moving = s.moveTo !== null && s.moveTo !== s.path;
    if (moving && tree.get(s.moveTo!) !== null) throw new Fail('exists', s.moveTo!);
    const sh = shape(before);
    let lines2 = sh.lines.slice();
    let cursor = 0;
    try {
      for (const c of s.chunks) {
        if (c.anchor !== null) {
          const ai = findAnchor(lines2, cursor, c.anchor, strict);
          if (ai < 0) throw new Fail('no-match', s.path);
          cursor = ai + 1; // cursor moves past the anchor
        }
        const O: string[] = [];
        const N: string[] = [];
        const ctxIdx = new Set<number>();
        const ctxOIdx: number[] = [];
        for (const bl of c.body) {
          if (bl.kind === 'ctx') {
            ctxIdx.add(N.length);
            ctxOIdx.push(O.length);
            O.push(bl.text);
            N.push(bl.text);
          } else if (bl.kind === 'old') O.push(bl.text);
          else N.push(bl.text);
        }
        const found = findTier(lines2, O, strict);
        if (O.length > 0) {
          let at = -1;
          let bi = -1;
          if (found) {
            for (let k = 0; k < found.occ.length; k += 1) {
              const x = found.occ[k]!;
              if (x >= cursor && (!c.eof || x + O.length === lines2.length)) { at = x; bi = k; break; }
            }
          }
          if (at < 0) throw new Fail('no-match', s.path);
          const bestTier = bi >= 0 ? found!.tiers[bi]! : 0;
          const Fn: string[] = [];
          let oi = 0;
          for (let k = 0; k < N.length; k += 1) {
            if (ctxIdx.has(k)) {
              Fn.push(lines2[at + ctxOIdx[oi]!]!);
              oi += 1;
            } else if (bestTier === 2) {
              const P = leadOf(O[0] ?? '');
              const ln = N[k]!;
              const F = leadOf(lines2[at]!);
              Fn.push(ln !== '' && ln.trim() !== '' && ln.startsWith(P) ? F + ln.slice(P.length) : ln);
            } else {
              Fn.push(N[k]!);
            }
          }
          lines2 = lines2.slice(0, at).concat(Fn, lines2.slice(at + O.length));
          cursor = at + Fn.length;
        } else {
          const at = c.eof ? lines2.length : Math.min(cursor, lines2.length);
          const Fn = N;
          lines2 = lines2.slice(0, at).concat(Fn, lines2.slice(at));
          cursor = at + Fn.length;
        }
      }
    } catch (e) {
      if (e instanceof Fail) throw new Fail(e.code, s.path);
      throw e;
    }
    const out = render(sh.br, lines2, sh.final);
    if (moving) {
      tree.now.set(s.moveTo!, out);
      tree.now.set(s.path, null);
      moves.push([s.path, s.moveTo!]);
    } else {
      tree.now.set(s.path, out);
    }
  });
}

// ---------- JSON edits (section 9) ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree, _strict) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree, _strict) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree, _strict) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- format detection (section 4) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- driver (sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = srEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else return { code: 2, out: ['error: format'] };
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  moves = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Pair deletions and additions into renames: old existed before and not after,
  // new did not exist before and does after.
  const delSet = new Set<string>();
  const addSet = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== null && now === null) delSet.add(p);
    if (was === null && now !== null) addSet.add(p);
  }
  const usedDel = new Set<string>();
  const renameNew = new Set<string>();
  const renameOld = new Map<string, string>(); // new -> old
  for (const [o, nw] of moves) {
    if (delSet.has(o) && addSet.has(nw)) {
      usedDel.add(o);
      renameNew.add(nw);
      renameOld.set(nw, o);
    }
  }
  const rows: string[] = [];
  const allPaths = new Set<string>([...tree.now.keys(), ...delSet]);
  for (const p of [...allPaths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (renameNew.has(p)) {
      rows.push(`R ${renameOld.get(p)} -> ${p}`);
      continue;
    }
    if (usedDel.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (check) return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
  for (const p of tree.now.keys()) {
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}