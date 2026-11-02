/**
 * layercheck core: Dockerfile layer size / waste analysis.
 *
 *   analyzeDockerfileLayers(dockerfile, layerSizes) -> result
 *
 * Parsing rules:
 * - Line-wise, honouring `\` line continuations: a logical
 *   line is its physical lines joined with a single space,
 *   and its `line` is the 1-based number of its first
 *   physical line.
 * - Blank lines and lines whose first non-space character is
 *   `#` are skipped (when not continuing a logical line).
 * - The keyword is the first whitespace-delimited token,
 *   uppercased; the instruction text is the full logical
 *   line, trimmed.
 *
 * RUN, COPY, and ADD produce layers. When `layer_sizes` is
 * supplied it must hold exactly one size per layer-producing
 * instruction, in Dockerfile order; a length mismatch is an
 * error naming both counts, never a silent misalignment.
 *
 * Waste flags are deterministic and reported in instruction
 * order; see the flag sites below for each rule.
 */
import type {
  BiggestLayer,
  DockerfileInstruction,
  LayercheckResult,
  WasteFlag,
} from "./types.js";

export const VERSION = "0.1.0";

const LAYER_KEYWORDS = new Set(["RUN", "COPY", "ADD"]);

const ARCHIVE_SUFFIXES = [".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz"];

/** Split raw Dockerfile text into logical lines with their start lines. */
function logicalLines(raw: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const physical = raw.split(/\r?\n/);
  let parts: string[] | null = null;
  let startLine = 0;
  for (let i = 0; i < physical.length; i++) {
    const rawLine = physical[i];
    if (parts === null) {
      const trimmed = rawLine.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      parts = [];
      startLine = i + 1;
    }
    const noTrail = rawLine.replace(/\s+$/, "");
    if (noTrail.endsWith("\\")) {
      parts.push(noTrail.slice(0, -1).trim());
      continue;
    }
    parts.push(noTrail.trim());
    out.push({ line: startLine, text: parts.filter((p) => p !== "").join(" ") });
    parts = null;
  }
  if (parts !== null) {
    // File ends mid-continuation: the accumulated parts still
    // form one final logical line.
    out.push({ line: startLine, text: parts.filter((p) => p !== "").join(" ") });
  }
  return out;
}

/**
 * First source token of a COPY/ADD instruction: the first
 * token after the keyword, skipping `--flag=value` tokens.
 */
function firstSourceToken(text: string): string | undefined {
  const tokens = text.split(/\s+/).slice(1);
  return tokens.find((t) => !t.startsWith("--"));
}

/** Analyze a Dockerfile's layers and waste. */
export function analyzeDockerfileLayers(
  dockerfile: unknown,
  layerSizes?: unknown,
): LayercheckResult {
  if (typeof dockerfile !== "string" || dockerfile.trim() === "") {
    throw new Error("dockerfile is required and must be a non-empty string");
  }
  const logical = logicalLines(dockerfile);
  if (logical.length === 0) {
    throw new Error("no instructions found in dockerfile");
  }

  const parsed = logical.map((entry, i) => {
    const keyword = entry.text.split(/\s+/)[0].toUpperCase();
    return {
      index: i + 1,
      line: entry.line,
      keyword,
      text: entry.text,
      produces_layer: LAYER_KEYWORDS.has(keyword),
    };
  });
  const layerCount = parsed.filter((p) => p.produces_layer).length;

  let sizes: number[] | undefined;
  if (layerSizes !== undefined && layerSizes !== null) {
    if (!Array.isArray(layerSizes)) {
      throw new Error("layer_sizes must be an array of numbers");
    }
    sizes = layerSizes.map((value, i) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`layer_sizes[${i}] must be a finite number`);
      }
      return value;
    });
    if (sizes.length !== layerCount) {
      throw new Error(
        `layer_sizes length (${sizes.length}) does not match the number of layer-producing instructions (${layerCount})`,
      );
    }
  }

  let layerOrdinal = 0;
  const instructions: DockerfileInstruction[] = parsed.map((p) => ({
    ...p,
    size_bytes: p.produces_layer && sizes ? sizes[layerOrdinal++] : null,
  }));

  const total_size_bytes = sizes
    ? sizes.reduce((sum, n) => sum + n, 0)
    : null;

  const biggest_layers: BiggestLayer[] = sizes
    ? instructions
        .filter(
          (ins): ins is DockerfileInstruction & { size_bytes: number } =>
            ins.produces_layer && ins.size_bytes !== null,
        )
        .map((ins) => ({
          index: ins.index,
          line: ins.line,
          keyword: ins.keyword,
          size_bytes: ins.size_bytes,
        }))
        .sort((a, b) => b.size_bytes - a.size_bytes || a.index - b.index)
    : [];

  // The first RUN whose text mentions "install" is the
  // dependency install step a broad copy must not precede.
  const firstInstall = instructions.find(
    (ins) => ins.keyword === "RUN" && ins.text.toLowerCase().includes("install"),
  );

  const waste_flags: WasteFlag[] = [];
  instructions.forEach((ins, pos) => {
    const prev = pos > 0 ? instructions[pos - 1] : undefined;

    // CONSECUTIVE_RUN: a RUN directly after another RUN (in
    // instruction order) — flagged on the second RUN's line.
    if (ins.keyword === "RUN" && prev?.keyword === "RUN") {
      waste_flags.push({
        code: "CONSECUTIVE_RUN",
        line: ins.line,
        message:
          `consecutive RUN instructions at lines ${prev.line} and ${ins.line}: ` +
          "combine them into a single RUN to avoid an extra layer",
      });
    }

    // BROAD_COPY_EARLY: copying the whole build context (`.`
    // or `./`) before the dependency install step busts the
    // cache for that step on every source change.
    if (ins.keyword === "COPY" || ins.keyword === "ADD") {
      const src = firstSourceToken(ins.text);
      if (
        (src === "." || src === "./") &&
        firstInstall !== undefined &&
        ins.index < firstInstall.index
      ) {
        waste_flags.push({
          code: "BROAD_COPY_EARLY",
          line: ins.line,
          message:
            `broad copy of '${src}' at line ${ins.line} appears before the dependency install step at line ${firstInstall.line}: ` +
            "copy only the dependency manifests before installing, so source changes do not bust the install layer's cache",
        });
      }
    }

    // APT_LEFTOVER: apt-get install without removing the
    // package lists leaves them baked into the layer.
    if (
      ins.keyword === "RUN" &&
      ins.text.includes("apt-get install") &&
      !ins.text.includes("rm -rf /var/lib/apt/lists")
    ) {
      waste_flags.push({
        code: "APT_LEFTOVER",
        line: ins.line,
        message:
          `RUN at line ${ins.line} uses apt-get install without removing /var/lib/apt/lists: ` +
          "append 'rm -rf /var/lib/apt/lists/*' to the same RUN so the package lists do not stay in the layer",
      });
    }

    // ADD_LOCAL: ADD's extra powers (remote fetch, archive
    // extraction) are wasted on an ordinary local path —
    // COPY is the clearer instruction for those.
    if (ins.keyword === "ADD") {
      const src = firstSourceToken(ins.text);
      if (
        src !== undefined &&
        !src.startsWith("http://") &&
        !src.startsWith("https://") &&
        !ARCHIVE_SUFFIXES.some((suffix) => src.endsWith(suffix))
      ) {
        waste_flags.push({
          code: "ADD_LOCAL",
          line: ins.line,
          message:
            `ADD at line ${ins.line} copies the local path '${src}': ` +
            "use COPY for local files that are not remote URLs or archives",
        });
      }
    }
  });

  return {
    layer_count: layerCount,
    total_size_bytes,
    instructions,
    biggest_layers,
    waste_flags,
  };
}

/** Render a payload as the JSON text block MCP clients show. */
export function formatPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}
