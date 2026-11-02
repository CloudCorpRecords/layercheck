# layercheck

Every RUN, COPY, and ADD in a Dockerfile leaves a layer in
the image, and layers are where image size and build-cache
pain live. layercheck reads a Dockerfile as plain text — no
docker daemon, no build — and reports what it finds:

- every instruction, parsed with `\` continuations joined
  and blank lines and `#` comments skipped, each marked with
  whether it produces a layer
- the layer count, and — when you supply per-layer sizes
  (as `docker history` reports them) — the total size and
  the layers ranked **biggest first**, so the fattest layer
  is the first thing you see
- deterministic waste flags, each with the line it fires on:
  - `CONSECUTIVE_RUN` — a RUN immediately after another
    RUN; the two could be one layer
  - `BROAD_COPY_EARLY` — a `COPY . .` (or `./`) placed
    before the dependency install step, busting its cache
    on every source change
  - `APT_LEFTOVER` — `apt-get install` without removing
    `/var/lib/apt/lists` in the same RUN
  - `ADD_LOCAL` — ADD used for an ordinary local file,
    where COPY is the clearer instruction (remote URLs and
    archives are fine)

If the supplied sizes do not line up with the number of
layer-producing instructions, layercheck says so and names
both counts instead of silently misaligning them.

## CLI

```bash
npx @reneturcios/layercheck analyze --dockerfile Dockerfile
npx @reneturcios/layercheck analyze --dockerfile Dockerfile --sizes sizes.json
npx @reneturcios/layercheck --version
```

`sizes.json` is a JSON array of numbers: the size in bytes
of each layer-producing instruction, in Dockerfile order.
The analysis is printed as one JSON object:
`{layer_count, total_size_bytes, instructions,
biggest_layers, waste_flags}`.

Exit codes: `0` on success, `1` on a runtime error
(including an unreadable file or a sizes length mismatch),
`2` on a usage error.

## MCP server

```bash
npx -y @reneturcios/layercheck mcp
```

MCP client config:

```json
{
  "mcpServers": {
    "layercheck": {
      "command": "npx",
      "args": ["-y", "@reneturcios/layercheck", "mcp"]
    }
  }
}
```

### Tools

- `analyze_dockerfile_layers` — Analyze a Dockerfile's
  layers and flag wasted ones.
  - `dockerfile` (string, required) — the Dockerfile text
  - `layer_sizes` (array of numbers, optional) — size in
    bytes of each layer-producing instruction, in
    Dockerfile order; its length must equal the number of
    layer-producing instructions

## Docker

```bash
docker run -i ghcr.io/cloudcorprecords/layercheck
docker run --rm -v "$PWD:/w" ghcr.io/cloudcorprecords/layercheck analyze --dockerfile /w/Dockerfile
```

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # tsx --test test/*.test.ts (pure local, no network)
npm run dev     # run the CLI from source
```

## License

MIT — Copyright (c) 2026 Rene Turcios
