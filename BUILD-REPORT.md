# layercheck — Build Report

MCP Rebuild 1000, Batch 12. Original program build from the
packages-100 plan (cluster B #22: "Dockerfile layer size /
waste analyzer, biggest layers first."), implemented from
the program spec in
`~/workspace/mcp-rebuild-100/specs-batch12/layercheck.md`.
There is no external original; the fixture is the program's
defined spec. Local build only — nothing pushed or
published.

Identity: repo `layercheck`, npm `@reneturcios/layercheck`,
MCP name `io.github.CloudCorpRecords/layercheck`, version
`0.1.0`, bin `layercheck` → `dist/cli.js`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json`, `server.json` (description "Dockerfile
  layer and waste analyzer: layer sizes biggest first, with
  deterministic waste flags.", 95 chars ≤100; npm entry
  carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/layercheck:0.1.0` carries **no**
  `version` field), `Dockerfile` (node:20-alpine two-stage,
  label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/layercheck"`),
  `tsconfig.json`, `.gitignore`, `LICENSE` (MIT, Copyright
  (c) 2026 Rene Turcios), `README.md` (fresh text),
  `CHANGELOG.md` (single 0.1.0 entry, 2026-10-27),
  `package-lock.json` (Route 3, see below)
- `src/index.ts`, `src/cli.ts` (`analyze` with
  `--dockerfile` / `--sizes`, `mcp`, `--version`; exit 2
  usage / 1 runtime error, argument validation before any
  file is read), `src/mcp.ts`, `src/types.ts`,
  `src/layercheck.ts` (core, `VERSION = "0.1.0"`)
- `test/layercheck.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (publish-container IMAGE = `ghcr.io/cloudcorprecords/layercheck`)

## Tools implemented (1)

- `analyze_dockerfile_layers` — `dockerfile` (string,
  required) and `layer_sizes` (array of numbers, optional:
  size in bytes of each layer-producing instruction, in
  Dockerfile order). Output `{layer_count,
  total_size_bytes, instructions, biggest_layers,
  waste_flags}` per the spec.

## Implementation notes

- `src/mcp.ts` uses the SDK's low-level `Server` with
  explicit inputSchema literals exactly matching the
  fixture, per the standing fleet rule; zod still validates
  every `tools/call`.
- Parsing is line-wise: `\` continuations join physical
  lines with a single space and the instruction's `line`
  is its first physical line; blank lines and `#` comment
  lines are skipped outside a continuation; the keyword is
  the first token, uppercased; the instruction `text` is
  the trimmed logical line.
- Only RUN, COPY, and ADD produce layers. Supplied sizes
  align onto them by layer order; `biggest_layers` sorts
  by size descending with ties broken by earlier
  instruction index; without sizes, sizes are null,
  `total_size_bytes` is null, and `biggest_layers` is [].
- Waste flags, in instruction order:
  `CONSECUTIVE_RUN` (RUN directly after a RUN, flagged on
  the second RUN's line, message names both lines),
  `BROAD_COPY_EARLY` (COPY/ADD whose first source token —
  skipping `--flag=value` tokens — is `.` or `./` and
  which appears before the first RUN whose text contains
  "install"), `APT_LEFTOVER` (RUN containing
  "apt-get install" but not "rm -rf /var/lib/apt/lists"),
  `ADD_LOCAL` (ADD whose first source token is not an
  http(s) URL and does not end in .tar, .tar.gz, .tgz,
  .tar.bz2, or .tar.xz).
- A `layer_sizes` length that differs from the
  layer-producing count is an error naming both counts;
  an empty dockerfile and a dockerfile with no
  instructions ("no instructions found") are errors.

## Verification (foreground, this session)

- `npx tsc` exit 0 (`dist/cli.js` built)
- `npm test` (`tsx --test test/*.test.ts`): **18 tests, 18
  pass, 0 fail** — continuation joining + first-line
  numbering, comment/blank skipping + keyword uppercasing,
  layer counting, size alignment + total, biggest-first
  order with tie-breaking, absent-sizes nulls, the length
  mismatch error naming both counts, non-array /
  non-number size rejection, all four waste flags
  (positive and negative cases, including the
  `--chown`-skipping broad copy and archive/remote ADD
  negatives), empty-dockerfile and no-instructions errors
- `dist/cli.js --version` → `0.1.0`; unknown command exits
  2 with usage; `analyze` on a sample Dockerfile with a
  sizes file prints the full report (5142 total, biggest
  first, BROAD_COPY_EARLY + CONSECUTIVE_RUN flagged); a
  missing sizes file exits 1
- Parity: `harness/parity.py` vs
  `harness/fixtures/layercheck-tools-original.json` →
  **PASS, parity 100.0, identical_tools 1/1**

## Lockfile status

`package-lock.json` generated clean via Route 3 (temp copy
with only `package.json`, offline `npm install
--package-lock-only --ignore-scripts --offline`), verified:
parses, name `@reneturcios/layercheck`, **128 package
entries**.

## Gaps / honest notes

- **BROAD_COPY_EARLY scope choice:** the flag fires only
  when an install-containing RUN exists later in the file
  (the broad copy appears *before* that step). A broad copy
  in a Dockerfile with no install step at all is not
  flagged — the spec's wording ("appearing before any RUN
  whose text contains install") is read existentially.
- **Install detection** is a substring check on the RUN
  text (case-insensitive "install"); a RUN that merely
  mentions the word in a comment-like argument would count
  as the install step. No attempt is made to parse shell.
- **Copy source tokens** are whitespace-delimited; the
  JSON-array form of COPY/ADD (`COPY ["src", "dest"]`) is
  not specially parsed, so its first "source token" would
  be the raw `["src",` token and broad-copy detection
  would not fire for that form.
- A file that ends mid-continuation still yields its
  accumulated final instruction rather than an error.
- Pure local text analysis by design: no docker daemon is
  consulted, so reported sizes are entirely the caller's
  `layer_sizes`, never measured.
- Container build not exercised locally; the
  publish-container workflow smoke-tests the image at
  publish time.
