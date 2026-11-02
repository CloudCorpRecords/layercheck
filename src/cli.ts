#!/usr/bin/env node
/**
 * layercheck CLI.
 *
 *   layercheck analyze --dockerfile <path> [--sizes <sizes.json>]
 *   layercheck mcp
 *
 * The Dockerfile is read as text; sizes.json is a JSON array
 * of numbers, one per layer-producing instruction in
 * Dockerfile order. Pure local analysis: no docker, no
 * network. Argument validation happens before any file is
 * read.
 * Exit codes: 0 success, 1 runtime error (including an
 * unreadable file or a layer_sizes length mismatch),
 * 2 usage error.
 */
import { readFileSync } from "node:fs";
import { analyzeDockerfileLayers, formatPayload, VERSION } from "./layercheck.js";

function usage(): never {
  console.error(`Usage:
  layercheck analyze --dockerfile <path> [--sizes <sizes.json>]
  layercheck mcp
  layercheck --version`);
  process.exit(2);
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (cmd !== "analyze") usage();

  // ---- Argument validation (before any file is read) ----
  const flags = ["--dockerfile", "--sizes"];
  if (rest.some((a) => a.startsWith("--") && !flags.includes(a))) usage();
  const dockerfilePath = flag(rest, "--dockerfile");
  if (dockerfilePath === undefined) usage();
  const sizesPath = flag(rest, "--sizes");
  if (rest.includes("--sizes") && sizesPath === undefined) usage();

  let dockerfile: string;
  try {
    dockerfile = readFileSync(dockerfilePath, "utf8");
  } catch (err) {
    console.error(
      `error: cannot read dockerfile '${dockerfilePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  let layerSizes: unknown;
  if (sizesPath !== undefined) {
    try {
      layerSizes = JSON.parse(readFileSync(sizesPath, "utf8"));
    } catch (err) {
      console.error(
        `error: cannot read or parse sizes file '${sizesPath}': ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  }

  try {
    const out = analyzeDockerfileLayers(dockerfile, layerSizes);
    console.log(formatPayload(out));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
