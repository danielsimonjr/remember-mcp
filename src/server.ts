import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { HANDLERS, TOOLS } from "./tools.ts";
import { PKG_VERSION } from "./version.ts";

/** Build a configured MCP server with all remember tools registered. */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "remember", version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const tool of TOOLS) {
    const handler = HANDLERS[tool.name];
    if (!handler) continue;
    const inputSchema = fromJsonSchema(tool.inputSchema as JsonSchemaType);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema,
      },
      async (args) => {
        try {
          const result = await handler((args ?? {}) as Record<string, unknown>);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `remember-mcp: handler '${tool.name}' threw: ${msg}\n`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ status: "error", error: msg }),
              },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
