import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeDockerfileLayers } from "../src/layercheck.js";

/**
 * All tests are pure local text analysis over inline
 * Dockerfile strings: no filesystem, no network, no docker.
 */

describe("analyzeDockerfileLayers — parsing", () => {
  it("joins backslash continuations with a single space and keeps the first line number", () => {
    const out = analyzeDockerfileLayers(
      [
        "FROM node:20-alpine",
        "RUN apt-get update && \\",
        "    apt-get install -y curl && \\",
        "    rm -rf /var/lib/apt/lists/*",
        "CMD [\"node\", \"server.js\"]",
      ].join("\n"),
    );
    assert.equal(out.instructions.length, 3);
    const run = out.instructions[1];
    assert.equal(run.keyword, "RUN");
    assert.equal(run.line, 2);
    assert.equal(
      run.text,
      "RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*",
    );
    assert.equal(out.instructions[2].line, 5);
  });

  it("skips blank lines and # comments, and uppercases keywords", () => {
    const out = analyzeDockerfileLayers(
      [
        "# a leading comment",
        "",
        "from node:20-alpine",
        "   ",
        "  # an indented comment",
        "workdir /app",
        "copy package.json ./",
        "run npm install",
      ].join("\n"),
    );
    assert.deepEqual(
      out.instructions.map((i) => i.keyword),
      ["FROM", "WORKDIR", "COPY", "RUN"],
    );
    assert.deepEqual(
      out.instructions.map((i) => i.line),
      [3, 6, 7, 8],
    );
    assert.deepEqual(
      out.instructions.map((i) => i.index),
      [1, 2, 3, 4],
    );
  });

  it("counts only RUN, COPY, and ADD as layer-producing", () => {
    const out = analyzeDockerfileLayers(
      [
        "FROM node:20-alpine",
        "ENV NODE_ENV=production",
        "WORKDIR /app",
        "COPY . .",
        "RUN npm install",
        "ADD bundle.tar.gz /opt/",
        "EXPOSE 3000",
        "CMD [\"node\", \"server.js\"]",
      ].join("\n"),
    );
    assert.equal(out.layer_count, 3);
    assert.deepEqual(
      out.instructions.map((i) => i.produces_layer),
      [false, false, false, true, true, true, false, false],
    );
  });
});

describe("analyzeDockerfileLayers — sizes", () => {
  const dockerfile = [
    "FROM node:20-alpine",
    "COPY package.json ./",
    "RUN npm install",
    "COPY src ./src",
  ].join("\n");

  it("aligns sizes to layer-producing instructions in order and totals them", () => {
    const out = analyzeDockerfileLayers(dockerfile, [100, 5000, 300]);
    assert.equal(out.total_size_bytes, 5400);
    assert.deepEqual(
      out.instructions.map((i) => i.size_bytes),
      [null, 100, 5000, 300],
    );
  });

  it("ranks biggest_layers biggest first, ties broken by earlier index", () => {
    const out = analyzeDockerfileLayers(dockerfile, [300, 5000, 300]);
    assert.deepEqual(out.biggest_layers, [
      { index: 3, line: 3, keyword: "RUN", size_bytes: 5000 },
      { index: 2, line: 2, keyword: "COPY", size_bytes: 300 },
      { index: 4, line: 4, keyword: "COPY", size_bytes: 300 },
    ]);
  });

  it("leaves sizes null and biggest_layers empty when sizes are absent", () => {
    const out = analyzeDockerfileLayers(dockerfile);
    assert.equal(out.total_size_bytes, null);
    assert.deepEqual(out.biggest_layers, []);
    assert.ok(out.instructions.every((i) => i.size_bytes === null));
  });

  it("rejects a layer_sizes length mismatch, naming both counts", () => {
    assert.throws(
      () => analyzeDockerfileLayers(dockerfile, [1, 2]),
      /layer_sizes length \(2\) does not match the number of layer-producing instructions \(3\)/,
    );
    assert.throws(
      () => analyzeDockerfileLayers(dockerfile, [1, 2, 3, 4]),
      /layer_sizes length \(4\) does not match the number of layer-producing instructions \(3\)/,
    );
  });

  it("rejects non-array sizes and non-number entries", () => {
    assert.throws(() => analyzeDockerfileLayers(dockerfile, "big"), /layer_sizes must be an array/);
    assert.throws(
      () => analyzeDockerfileLayers(dockerfile, [1, "x", 3]),
      /layer_sizes\[1\] must be a finite number/,
    );
  });
});

describe("analyzeDockerfileLayers — waste flags", () => {
  it("flags CONSECUTIVE_RUN on the second RUN, naming both lines", () => {
    const out = analyzeDockerfileLayers(
      ["FROM x", "RUN echo a", "RUN echo b", "COPY . ."].join("\n"),
    );
    const flags = out.waste_flags.filter((f) => f.code === "CONSECUTIVE_RUN");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].line, 3);
    assert.match(flags[0].message, /lines 2 and 3/);
  });

  it("does not flag RUNs separated by another instruction", () => {
    const out = analyzeDockerfileLayers(
      ["FROM x", "RUN echo a", "COPY package.json ./", "RUN npm install"].join("\n"),
    );
    assert.equal(out.waste_flags.filter((f) => f.code === "CONSECUTIVE_RUN").length, 0);
  });

  it("flags BROAD_COPY_EARLY for a whole-context copy before the install step", () => {
    const dot = analyzeDockerfileLayers(
      ["FROM x", "COPY . .", "RUN npm install"].join("\n"),
    );
    const flags = dot.waste_flags.filter((f) => f.code === "BROAD_COPY_EARLY");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].line, 2);
    const dotSlash = analyzeDockerfileLayers(
      ["FROM x", "COPY ./ /app", "RUN pip install -r requirements.txt"].join("\n"),
    );
    assert.equal(
      dotSlash.waste_flags.filter((f) => f.code === "BROAD_COPY_EARLY").length,
      1,
    );
  });

  it("does not flag a broad copy after install, a narrow copy before it, or flags-skipping sources", () => {
    const after = analyzeDockerfileLayers(
      ["FROM x", "COPY package.json ./", "RUN npm install", "COPY . ."].join("\n"),
    );
    assert.equal(after.waste_flags.filter((f) => f.code === "BROAD_COPY_EARLY").length, 0);
    const withFlag = analyzeDockerfileLayers(
      ["FROM x", "COPY --chown=node:node . .", "RUN npm install"].join("\n"),
    );
    assert.equal(
      withFlag.waste_flags.filter((f) => f.code === "BROAD_COPY_EARLY").length,
      1,
    );
  });

  it("flags APT_LEFTOVER when apt lists are not removed in the same RUN", () => {
    const out = analyzeDockerfileLayers(
      ["FROM x", "RUN apt-get update && apt-get install -y curl"].join("\n"),
    );
    const flags = out.waste_flags.filter((f) => f.code === "APT_LEFTOVER");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].line, 2);
  });

  it("does not flag APT_LEFTOVER when the lists are removed, or without apt-get install", () => {
    const cleaned = analyzeDockerfileLayers(
      ["FROM x", "RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*"].join("\n"),
    );
    assert.equal(cleaned.waste_flags.filter((f) => f.code === "APT_LEFTOVER").length, 0);
    const noApt = analyzeDockerfileLayers(["FROM x", "RUN apk add curl"].join("\n"));
    assert.equal(noApt.waste_flags.filter((f) => f.code === "APT_LEFTOVER").length, 0);
  });

  it("flags ADD_LOCAL for an ordinary local path", () => {
    const out = analyzeDockerfileLayers(["FROM x", "ADD server.js /app/"].join("\n"));
    const flags = out.waste_flags.filter((f) => f.code === "ADD_LOCAL");
    assert.equal(flags.length, 1);
    assert.equal(flags[0].line, 2);
    assert.match(flags[0].message, /server\.js/);
  });

  it("does not flag ADD_LOCAL for remote URLs or known archives", () => {
    const out = analyzeDockerfileLayers(
      [
        "FROM x",
        "ADD https://example.com/tool /usr/local/bin/tool",
        "ADD bundle.tar.gz /opt/",
        "ADD bundle.tgz /opt/",
        "ADD bundle.tar /opt/",
      ].join("\n"),
    );
    assert.equal(out.waste_flags.filter((f) => f.code === "ADD_LOCAL").length, 0);
  });
});

describe("analyzeDockerfileLayers — validation", () => {
  it("rejects a missing or empty dockerfile", () => {
    assert.throws(() => analyzeDockerfileLayers(""), /dockerfile is required/);
    assert.throws(() => analyzeDockerfileLayers("  \n  "), /dockerfile is required/);
    assert.throws(() => analyzeDockerfileLayers(undefined), /dockerfile is required/);
  });

  it("rejects a dockerfile with no instructions", () => {
    assert.throws(
      () => analyzeDockerfileLayers("# only a comment\n\n# another\n"),
      /no instructions found/,
    );
  });
});
