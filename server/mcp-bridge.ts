import {
	McpClient,
	StdioTransport,
	StreamableHttpTransport,
	type VendorToolDefinition,
	type VendorToolResult,
	type VendorToolUpdate,
} from "./pi-sdk.cjs";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

/**
 * Bridges Paseo's injected MCP servers (session.open.config.mcpServers) into
 * the embedded pi session as custom tools, using pi's own MCP tool naming
 * convention (`mcp__<server>__<tool>`) so tool provenance stays readable in
 * the timeline and matches what pi's built-in MCP extension would produce.
 *
 * The plugin provider contract advertises MCP support unconditionally, so a
 * session whose servers go unwired would silently lose Paseo-side tools.
 */
export interface McpBridge {
	tools: VendorToolDefinition[];
	dispose(): Promise<void>;
}

interface McpConnection {
	client: McpClient;
	tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

type McpCallContent = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
};

function contentToAgentContent(
	blocks: McpCallContent[],
): VendorToolResult["content"] {
	const out: VendorToolResult["content"] = [];
	for (const block of blocks ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			out.push({ type: "text", text: block.text });
		} else if (block.type === "image" && typeof block.data === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
		}
	}
	if (out.length === 0) out.push({ type: "text", text: "" });
	return out;
}

/** Failures per server are contained: one bad server must not sink the session. */
async function connectServer(
	serverName: string,
	config: ProviderMcpServerConfig,
): Promise<McpConnection | undefined> {
	const client = new McpClient({ name: "autumn-studio", version: "0.1.0" });
	try {
		if (config.type === "stdio") {
			await client.connect(
				new StdioTransport({
					command: config.command,
					args: config.args ?? [],
					env: config.env as Record<string, string> | undefined,
				}),
			);
		} else {
			await client.connect(
				new StreamableHttpTransport({
					url: config.url,
					headers: config.headers as Record<string, string> | undefined,
				}),
			);
		}
		const tools = await client.listTools();
		return { client, tools };
	} catch {
		await client.close().catch(() => {});
		return undefined;
	}
}

export async function createMcpBridge(
	mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>,
): Promise<McpBridge> {
	const connections = new Map<string, McpConnection>();
	const tools: VendorToolDefinition[] = [];

	// Connect in parallel; tool registration order stays stable because
	// entries iterate in the original key order below.
	const names = Object.keys(mcpServers);
	const connected = await Promise.all(
		names.map(async (serverName) => ({
			serverName,
			connection: await connectServer(serverName, mcpServers[serverName]),
		})),
	);
	for (const { serverName, connection } of connected) {
		if (!connection) continue;
		connections.set(serverName, connection);

		for (const tool of connection.tools) {
			const toolName = `mcp__${serverName}__${tool.name}`;
			tools.push({
				name: toolName,
				label: toolName,
				description: tool.description ?? `Tool ${tool.name} from MCP server ${serverName}`,
				// MCP tools carry a JSON Schema; pi validates with TypeBox, which
				// speaks JSON Schema — pass the schema through unchanged.
				parameters: tool.inputSchema ?? { type: "object" },
				execute: async (_toolCallId, params, _signal, onUpdate): Promise<VendorToolResult> => {
					const report: VendorToolUpdate = { content: [{ type: "text", text: "Calling MCP tool…" }] };
					onUpdate?.(report);
					try {
						const result = await connection.client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
						return {
							content: contentToAgentContent(result.content ?? []),
							details: undefined,
							isError: result.isError === true,
						};
					} catch (error) {
						return {
							content: [{ type: "text", text: `MCP tool ${toolName} failed: ${error instanceof Error ? error.message : String(error)}` }],
							details: undefined,
							isError: true,
						};
					}
				},
			});
		}
	}

	return {
		tools,
		async dispose() {
			for (const connection of connections.values()) {
				await connection.client.close().catch(() => {});
			}
			connections.clear();
		},
	};
}
