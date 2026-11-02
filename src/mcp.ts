/**
 * layercheck MCP server. Tools: analyze_dockerfile_layers.
 *
 * Why the low-level Server instead of McpServer: the high-level
 * helper converts zod schemas to JSON Schema and injects keys
 * not in this tool's defined spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema
 * parity with the spec. This file serves tools/list with the
 * spec's exact input schemas as explicit literals, while zod
 * still validates every tools/call argument set.
 *
 * The analysis is pure local text analysis: no docker daemon,
 * no upstream API, no authentication, no configuration.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { analyzeDockerfileLayers, formatPayload, VERSION } from "./layercheck.js";

const AnalyzeArgs = z.object({
  dockerfile: z.string().min(1),
  layer_sizes: z.array(z.number()).optional(),
});

const TOOLS = [
  {
    name: "analyze_dockerfile_layers",
    description:
      "Analyze a Dockerfile's layers: parse its instructions, rank layer sizes biggest first when sizes are supplied, and flag wasted layers with deterministic checks (consecutive RUNs, broad copies before the install step, leftover apt lists, ADD used for local files).",
    inputSchema: {
      type: "object" as const,
      properties: {
        dockerfile: { type: "string", description: "The Dockerfile text" },
        layer_sizes: {
          type: "array",
          description:
            "Size in bytes of each layer-producing instruction (RUN, COPY, ADD), in Dockerfile order, as docker history would report them; length must equal the number of layer-producing instructions",
          items: { type: "number" },
        },
      },
      required: ["dockerfile"],
    },
  },
];

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "layercheck", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let out: unknown;
    if (name === "analyze_dockerfile_layers") {
      const parsed = AnalyzeArgs.parse(args ?? {});
      out = analyzeDockerfileLayers(parsed.dockerfile, parsed.layer_sizes);
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return textResult(formatPayload(out));
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
