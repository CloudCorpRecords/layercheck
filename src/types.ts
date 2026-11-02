/**
 * layercheck types.
 *
 * layercheck reads a Dockerfile as plain text and reports on
 * its layers. Only three instructions create a filesystem
 * layer — RUN, COPY, and ADD — so the report counts those,
 * aligns caller-supplied per-layer sizes (as `docker history`
 * would report them) onto them biggest first, and runs a
 * small set of deterministic waste checks over the parsed
 * instruction list:
 *
 *   CONSECUTIVE_RUN   two RUNs back to back that could be one
 *   BROAD_COPY_EARLY  a whole-context copy placed before the
 *                     dependency install step
 *   APT_LEFTOVER      apt-get install without cleaning the
 *                     package lists out of the same layer
 *   ADD_LOCAL         ADD used for an ordinary local file
 *
 * Everything is local text analysis: no docker daemon, no
 * network, no image is built or pulled.
 */

/** One parsed Dockerfile instruction. */
export interface DockerfileInstruction {
  /** 1-based position among all parsed instructions. */
  index: number;
  /** 1-based number of the instruction's first physical line. */
  line: number;
  /** Instruction keyword, uppercased (FROM, RUN, COPY, ...). */
  keyword: string;
  /** Full logical line, continuations joined with a single space. */
  text: string;
  /** True for RUN, COPY, and ADD — the layer-producing instructions. */
  produces_layer: boolean;
  /** Size from `layer_sizes` by layer order, or null when sizes are absent. */
  size_bytes: number | null;
}

/** A layer-producing instruction ranked in `biggest_layers`. */
export interface BiggestLayer {
  index: number;
  line: number;
  keyword: string;
  size_bytes: number;
}

export type WasteFlagCode =
  | "CONSECUTIVE_RUN"
  | "BROAD_COPY_EARLY"
  | "APT_LEFTOVER"
  | "ADD_LOCAL";

/** One deterministic waste finding. */
export interface WasteFlag {
  code: WasteFlagCode;
  /** 1-based line the finding is reported on. */
  line: number;
  message: string;
}

/** The analysis report. */
export interface LayercheckResult {
  /** Number of layer-producing instructions (RUN, COPY, ADD). */
  layer_count: number;
  /** Sum of `layer_sizes`, or null when sizes were not supplied. */
  total_size_bytes: number | null;
  /** Every parsed instruction, in Dockerfile order. */
  instructions: DockerfileInstruction[];
  /** Layer-producing instructions by size, biggest first; [] without sizes. */
  biggest_layers: BiggestLayer[];
  /** Waste findings, in instruction order. */
  waste_flags: WasteFlag[];
}
