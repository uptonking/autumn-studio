import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@getpaseo/plugin/server/provider";
import type { SettingsValues } from "../shared/settings.js";
import { externalAuthPath, externalModelsPath } from "./external-pi.js";
import { agentDir } from "./paths.js";

/**
 * Writes private configuration files (auth.json, models.json, mcp.json)
 * into the isolated plugin data directory ($PASEO_HOME/plugin-data/autumn-studio/agent-dir).
 *
 * This cleanly isolates Autumn Studio from ~/.pi/agent while allowing manual
 * settings and (optionally) external Pi credentials to be merged.
 */
export function writePrivateConfig(
	values: SettingsValues,
	mcpServers?: Record<string, McpServerConfig>,
): void {
	const dir = agentDir();
	mkdirSync(dir, { recursive: true });

	const auth: Record<
		string,
		{ type: "api_key"; key: string; env?: Record<string, string> }
	> = {};
	const models: { providers: Record<string, any> } = { providers: {} };

	// 1. If reuseExternalPi is enabled, load external configs as baseline
	if (values.reuseExternalPi === true) {
		if (existsSync(externalAuthPath())) {
			try {
				const extAuth = JSON.parse(readFileSync(externalAuthPath(), "utf8"));
				if (typeof extAuth === "object" && extAuth !== null) {
					Object.assign(auth, extAuth);
				}
			} catch {}
		}
		if (existsSync(externalModelsPath())) {
			try {
				const extModels = JSON.parse(readFileSync(externalModelsPath(), "utf8"));
				if (
					typeof extModels?.providers === "object" &&
					extModels.providers !== null
				) {
					Object.assign(models.providers, extModels.providers);
				}
			} catch {}
		}
	}

	// 2. Overlay manual provider entries (manual settings take precedence over external)
	for (const entry of values.providers) {
		if (!entry.enabled) continue;

		if (entry.type === "custom") {
			if (entry.baseUrl?.trim()) {
				const entryModels = (entry.models || []).map((id) => ({
					id,
					name: id,
					reasoning: entry.reasoning,
					contextWindow: 128000,
					maxTokens: 16384,
				}));
				models.providers[entry.id] = {
					name: entry.name || entry.id,
					baseUrl: entry.baseUrl.trim(),
					api: "openai-completions",
					...(entry.apiKey?.trim() ? { apiKey: entry.apiKey.trim() } : {}),
					...(entryModels.length > 0 ? { models: entryModels } : {}),
				};
			}
		} else {
			// Built-in standard provider (anthropic, openai, google, groq, etc.)
			if (entry.apiKey?.trim()) {
				auth[entry.type] = {
					type: "api_key",
					key: entry.apiKey.trim(),
				};
			}
			// If baseUrl is overridden for a standard provider
			if (entry.baseUrl?.trim()) {
				models.providers[entry.type] = {
					name: entry.name || entry.type,
					baseUrl: entry.baseUrl.trim(),
				};
			}
		}
	}

	writeFileSync(join(dir, "auth.json"), JSON.stringify(auth, null, 2), "utf8");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify(models, null, 2),
		"utf8",
	);

	// 3. Write mcp.json for workspace MCP servers
	const piMcpServers: Record<string, any> = {};
	if (mcpServers) {
		for (const [name, config] of Object.entries(mcpServers)) {
			if (config.type === "stdio") {
				piMcpServers[name] = {
					command: config.command,
					...(config.args ? { args: config.args } : {}),
					...(config.env ? { env: config.env } : {}),
				};
			} else if (config.type === "http" || config.type === "sse") {
				piMcpServers[name] = {
					url: config.url,
					...(config.headers ? { headers: config.headers } : {}),
				};
			}
		}
	}
	writeFileSync(
		join(dir, "mcp.json"),
		JSON.stringify({ mcpServers: piMcpServers }, null, 2),
		"utf8",
	);
}
