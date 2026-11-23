# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xzur4/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/0xzur4/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads all four to one specification (`SPEC.md`): a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; no dependencies.

## Matching

Models drift whitespace and indentation, so an edit's old lines are found at the first of three tiers at which they occur at least once: exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed. Context lines are written back as the file's own lines, and at the third tier replacement lines are re-indented from the patch's indentation to the file's. `--strict` tries the first tier only. A unified hunk takes the occurrence nearest to the line number it names; a SEARCH/REPLACE block fails as ambiguous when its old lines occur more than once; a V4A chunk takes the first occurrence at or after its cursor.

## Exit codes and output

- Exit 2 with `error: usage`, `error: no-patch`, `error: format` or `error: parse <N>` when the patch cannot be read.
- Exit 1 with one `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then `failed: <k> of <n> edits`. When any edit fails, no file is written.
- Exit 0 with one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move), then `ok: <n> files`.

## Files

- `main.ts` — the CLI. The starter's command line, output, safe paths, format detection, JSON edits and all-or-nothing write, plus my implementation of line matching at three tiers, unified diffs, SEARCH/REPLACE blocks and V4A patches.
- `runner.ts` — the kit's runner, kept as it is. In a trial it reads the checks from the environment and runs `main.ts` on each one.
- `check.ts` — runs `main.ts` on the practice set.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.

## Verification

The kit's practice set: 100 of 100 passed (practice score 1000).

```sh
node check.ts <practice.json>
```

Plus 43 hand-written edge cases for sentences of the spec the practice set does not show (header errors, empty-file inserts, no-newline handling, previous-block paths, anchor and cursor behaviour in V4A, usage/parse precedence, strict matching): all pass.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qmvvr0pk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
