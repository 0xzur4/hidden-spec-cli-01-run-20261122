// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

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

/** A file as lines (SPEC.md section 3): its break, its lines, whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/**
 * Occurrences of O in lines at or after `from`, at the first tier (0, 1, 2) with at least one.
 * With strict only tier 0 is tried. Positions are 0-based and ascending.
 */
function occurrencesFrom(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return { tier: 0, positions: [] };
}

/** One line of N: `ctx >= 0` copies the file's matched line O[ctx]; `ctx === -1` is a new line. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines that replace O's match at `at` (SPEC.md section 5). Context lines are the file's own
 * matched lines; at tier 2 every other non-blank line of N is re-indented from O's first line to
 * the file's first matched line.
 */
function replacement(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[at]!);
    p = leadingWs(o[0]!);
  }
  return n.map((e) => {
    if (e.ctx >= 0) return fileLines[at + e.ctx]!;
    if (tier === 2 && e.text !== '' && !/^[ \t]*$/.test(e.text) && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order the edits ran. */
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
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
    return (tree) => {
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

/** A unified hunk (SPEC.md section 6): O is its context and `-` lines, N its context and `+` lines. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  backslash: boolean;
  /** a `\` line follows the hunk's last `+` line */
  lastPlusBackslash: boolean;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '' || l[0] === ' ') {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
      lastCtxOrPlus = idx;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
      lastCtxOrPlus = idx;
      lastPlus = idx;
    }
  });
  const backslash =
    lastCtxOrPlus >= 0 && body[lastCtxOrPlus + 1] !== undefined && body[lastCtxOrPlus + 1]![0] === '\\';
  const lastPlusBackslash =
    lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
  return { a, o, n, backslash, lastPlusBackslash };
}

/** Apply a section's hunks, in order, to a file's text; throws Fail('no-match', path). */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.n.map((e) => e.text));
      if (atEnd) f.final = !h.backslash;
      d += h.n.length;
    } else {
      const { tier, positions } = occurrencesFrom(f.lines, h.o, strict, 0);
      if (positions.length === 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = replacement(f.lines, best, h.o, h.n, tier);
      const reachedEnd = best + h.o.length === f.lines.length;
      f.lines.splice(best, h.o.length, ...repl);
      if (reachedEnd) f.final = !h.backslash;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(f);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  if (oldPath === null || sec.newFile) {
    const p = newPath === undefined || newPath === null ? '' : newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (e.ctx < 0) plus.push(e.text);
      let content = '';
      if (plus.length > 0) {
        let noBreak = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.n.some((e) => e.ctx < 0)) {
            noBreak = h.lastPlusBackslash;
            break;
          }
        }
        content = plus.join('\n') + (noBreak ? '' : '\n');
      }
      tree.now.set(p, content);
    };
  }
  if (newPath === null || sec.deletedFile) {
    const p = oldPath === undefined ? '' : oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const oldP = oldPath === undefined ? '' : oldPath;
  const newP = newPath === undefined ? '' : newPath;
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyUnifiedHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyUnifiedHunks(before, sec.hunks, strict, oldP));
  };
}

/** Read a patch as unified diffs (SPEC.md section 6): one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let pendingA = 0;
  let i = 0;
  const n = lines.length;
  const newSection = (): Section => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    if (state === 'body') {
      const body: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (isDiffGitLine(l)) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec!.hunks.push(buildHunk(pendingA, body));
      state = 'after';
      continue;
    }
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && sec !== null && sec.pairOld === undefined) {
        const op = headerPath(line);
        const np = headerPath(lines[i + 1]!);
        sec.pairOld = op === '/dev/null' ? null : op;
        sec.pairNew = np === '/dev/null' ? null : np;
        i += 2;
        continue;
      }
      sec = newSection();
      sections.push(sec);
      state = 'header';
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      pendingA = parseInt(m[1]!, 10);
      state = 'body';
      i++;
      continue;
    }
    if (state === 'header' && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (state === 'header' && sec !== null) {
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7): one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceIdx; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceIdx = rep;
    i = rep + 1;
  }
  return blocks.map((b) => {
    return (tree) => {
      const p = b.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (b.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const { tier, positions } = occurrencesFrom(f.lines, b.oldLines, strict, 0);
      if (positions.length === 0) throw new Fail('no-match', p);
      if (positions.length > 1) throw new Fail('ambiguous', p);
      const at = positions[0]!;
      const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
      const repl = replacement(f.lines, at, b.oldLines, n, tier);
      f.lines.splice(at, b.oldLines.length, ...repl);
      tree.now.set(p, joinFile(f));
    };
  });
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

/** Read a patch as a V4A patch (SPEC.md section 8): one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    const kind = sectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const markerLen = kind === 'add' ? '*** Add File: '.length : kind === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length;
    const path = line.slice(markerLen).trim();
    const startLine = i + 1;
    i++;
    let end = i;
    while (end < last && sectionStart(lines[end]!) === null) end++;
    const raw = lines.slice(i, end);
    let rawEnd = raw.length;
    while (rawEnd > 0 && blank(raw[rawEnd - 1]!)) rawEnd--;
    const body = raw.slice(0, rawEnd);
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const l = body[k]!;
        if (l === '') fileLines.push('');
        else if (l[0] === '+') fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + k + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < body.length && body[k]!.startsWith('*** Move to: ')) {
        moveTo = body[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (k < body.length) {
        const l = body[k]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
          chunks.push(cur);
          k++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + k + 1}`);
          cur.eof = true;
          cur = null;
          k++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, o: [], n: [] };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${i + k + 1}`);
          }
          if (l === '' || l[0] === ' ') {
            const text = l === '' ? '' : l.slice(1);
            cur.o.push(text);
            cur.n.push({ text, ctx: cur.o.length - 1 });
          } else if (l[0] === '-') {
            cur.o.push(l.slice(1));
          } else {
            cur.n.push({ text: l.slice(1), ctx: -1 });
          }
          k++;
          continue;
        }
        throw new Exit2(`error: parse ${i + k + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const occ = occurrencesFrom(f.lines, [ch.anchor], strict, cursor);
            if (occ.positions.length === 0) throw new Fail('no-match', path);
            cursor = occ.positions[0]! + 1;
          }
          if (ch.o.length === 0) {
            const pos = ch.eof ? f.lines.length : cursor;
            const ins = ch.n.map((e) => e.text);
            f.lines.splice(pos, 0, ...ins);
            cursor = pos + ins.length;
          } else {
            const occ = occurrencesFrom(f.lines, ch.o, strict, cursor);
            let positions = occ.positions;
            if (ch.eof) positions = positions.filter((p) => p + ch.o.length === f.lines.length);
            if (positions.length === 0) throw new Fail('no-match', path);
            const at = positions[0]!;
            const repl = replacement(f.lines, at, ch.o, ch.n, occ.tier);
            f.lines.splice(at, ch.o.length, ...repl);
            cursor = at + repl.length;
          }
        }
        const after = joinFile(f);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, after);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, after);
        }
      });
    }
    i = end;
  }
  return edits;
}

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const kindOf = new Map<string, string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    kindOf.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (kindOf.get(oldP) === 'D' && kindOf.get(newP) === 'A') {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const p of [...kindOf.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${kindOf.get(p)} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
