# mend

`mend` is one command-line tool that applies an edit an AI model wrote to a tree
of text files. Models write edits in four formats; `mend` reads all four to one
written specification, finds the lines an edit names even when the model drifted
their whitespace or indentation, and changes every file or none.

## Formats

- **Unified diff** — `diff --git` / `---`/`+++` patches, often with wrong line
  numbers. Hunks are matched by content at three whitespace tiers, not by line
  number.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks,
  with the path on the nearest non-blank line above the block.
- **V4A** — `*** Begin Patch` / `*** Add File` / `*** Update File` /
  `*** Delete File` / `*** Move to:` / `@@ <anchor>` / `*** End of File` /
  `*** End Patch`.
- **JSON** — a JSON array of edit objects or JSON Lines, with `create`,
  `str_replace`, and `insert` commands.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a`, `json`
  (`auto`, the default, detects it).
- `--check` does everything but write: same output and exit code, no file
  changed.
- `--strict` matches lines exactly (tier 0 only).
- `PATCH` is a path relative to the working directory, or `-` (or absent) for
  standard input.

## Atomicity

Every file changes or none does. If any edit fails, no file is written and the
tool exits non-zero with one `error: <code> <path>` line per failed edit plus a
`failed: <k> of <n> edits` summary. On success it prints one line per changed
path (`A`/`M`/`D`/`R`) in byte order and `ok: <n> files`.

## Matching

Unified hunks, SEARCH/REPLACE blocks, and V4A chunks find their old lines at the
first of three tiers that occurs: exact, trailing-whitespace-insensitive, or
leading-and-trailing-whitespace-insensitive. At the loosest tier, new lines are
re-indented to match the file's own indentation.

## License

MIT — see [LICENSE](LICENSE).