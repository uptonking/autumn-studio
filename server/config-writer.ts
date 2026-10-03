import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import type { AutumnSettings } from "../shared/settings.js";
import { externalAuthPath, externalModelsPath } from "./external-pi.js";
import { pluginDataDir } from "./paths.js";

/**
 * Generates the pi configuration files (auth.json, models.json, mcp.json) a
 * spawned pi RPC child reads from its PI_CODING_AGENT_DIR. Everything the
 * child sees lives in the target dir: plugin settings (manual entries, plus
 * /v1/models discovery), and — when the reuse toggle is on — a copy of the
 * external pi installation's auth/models. The user's external directory is
 * never pointed at directly, so a session child can never write there.
 */

const KNOWN_TYPES = new Set([
	"amazon-bedrock",
	"anthropic",
	"azure-openai-responses",
	"cerebras",
	"cloudflare-ai-gateway",
	"deepseek",
	"fireworks",
	"google",
	"groq",
	"mistral",
	"moonshotai",
	"openai",
	"openrouter",
	"together",
	"xai",
	"zai",
]);

export function isKnownProviderType(type: string): boolean {
	return KNOWN_TYPES.has(type);
}

/** Zero rates: custom endpoints have unknown pricing; pi computes cost 0. */
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULT_CUSTOM_MODEL_ID = "default";
const MAX_DISCOVERED_MODELS = 200;
const MAX_PERSISTED_MODELS = 500;
const PROBE_TIMEOUT_MS = 6000;

/**
 * In-process cache of /v1/models probes, keyed by baseUrl. Successful
 * discoveries live forever (the merged known-good set only accumulates);
 * degraded results (endpoint dead or hanging → persisted last-known-good)
 * expire so a recovered endpoint is probed again instead of being dead for
 * the plugin process's whole lifetime. Without the TTL, every session open
 * after a failure would pay the full 2×6s probe stall again.
 */
const DEGRADED_DISCOVERY_TTL_MS = 60_000;
const discoveryCache = new Map<string, { ids: string[]; expiresAt: number }>();

function cachedDiscovery(baseUrl: string): string[] | undefined {
	const entry = discoveryCache.get(baseUrl);
	if (!entry) return undefined;
	if (entry.expiresAt < Date.now()) {
		discoveryCache.delete(baseUrl);
		return undefined;
	}
	return entry.ids;
}

/** Last-known-good discovery results, keyed by baseUrl, persisted in the plugin data dir. */
const DISCOVERY_CACHE_FILE = "discovery-cache.json";

function readPersistedDiscovery(baseUrl: string): string[] {
	try {
		const file = join(pluginDataDir(), DISCOVERY_CACHE_FILE);
		const doc = JSON.parse(readFileSync(file, "utf8")) as { endpoints?: Record<string, string[]> };
		return doc.endpoints?.[baseUrl] ?? [];
	} catch {
		return [];
	}
}

/**
 * Merge discovered ids into the persisted known-good set. Merging (not
 * replacing) means a flaky network path that returns a truncated catalog
 * can never wipe models that previously discovered fine; genuinely removed
 * upstream models linger but fail with a clear API error when used.
 */
function writePersistedDiscovery(baseUrl: string, modelIds: string[]): void {
	try {
		const dir = pluginDataDir();
		mkdirSync(dir, { recursive: true });
		const file = join(dir, DISCOVERY_CACHE_FILE);
		let doc: { endpoints?: Record<string, string[]> } = {};
		try {
			doc = JSON.parse(readFileSync(file, "utf8"));
		} catch {}
		doc.endpoints ??= {};
		doc.endpoints[baseUrl] = [...new Set([...(doc.endpoints[baseUrl] ?? []), ...modelIds])].slice(
			0,
			MAX_PERSISTED_MODELS,
		);
		writeFileSync(file, JSON.stringify(doc, null, 1));
	} catch {
		// The cache is an optimization; failures are invisible.
	}
}

/**
 * Discover model ids from an OpenAI-compatible `/v1/models` endpoint.
 *
 * Ordering on failure: in-process cache → persisted last-known-good list →
 * []. Callers layer the entry's manual models on top, so a broken or hanging
 * discovery endpoint degrades to the user's manual list instead of wiping it.
 */
async function probeOpenAiModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const cached = cachedDiscovery(baseUrl);
	if (cached) return cached;

	const base = baseUrl.replace(/\/+$/, "");
	const url = base.endsWith("/models") ? base : `${base}/models`;
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	// Two attempts: flaky local network paths (VPN/TUN fake-IP setups) reset
	// connections sporadically, and a second attempt usually gets through.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			const res = await fetch(url, { headers, signal: controller.signal });
			clearTimeout(timeout);

			if (!res.ok) break;
			const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
			const ids = Array.isArray(data?.data)
				? data.data
						.map((m) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : null))
						.filter((id): id is string => id !== null)
						.slice(0, MAX_DISCOVERED_MODELS)
				: [];
			if (ids.length > 0) {
				// The effective known-good set accumulates: a flaky network
				// path returning a truncated catalog can never shrink it.
				const merged = [...new Set([...ids, ...readPersistedDiscovery(baseUrl)])].slice(
					0,
					MAX_DISCOVERED_MODELS,
				);
				discoveryCache.set(baseUrl, { ids: merged, expiresAt: Number.POSITIVE_INFINITY });
				writePersistedDiscovery(baseUrl, merged);
				return merged;
			}
			break;
		} catch {
			// Retry once, then fall through to the persisted known-good list.
		}
	}
	const degraded = readPersistedDiscovery(baseUrl);
	discoveryCache.set(baseUrl, { ids: degraded, expiresAt: Date.now() + DEGRADED_DISCOVERY_TTL_MS });
	return degraded;
}

function customModelDefinition(id: string, reasoning: boolean) {
	return {
		id,
		name: id,
		contextWindow: 65536,
		maxTokens: 8192,
		reasoning,
		// Claim image input: prompt images pass through as OpenAI-style image
		// parts, and endpoints that can't accept them fail with a clear error
		// the agent relays. Pretending text-only would hard-block capable ones.
		input: ["text", "image"] as ("text" | "image")[],
		cost: UNKNOWN_COST,
	};
}

export interface WriteAgentConfigOptions {
	/** Paseo-injected MCP servers for the session; omitted/empty → empty mcp.json. */
	mcpServers?: Readonly<Record<string, ProviderMcpServerConfig>>;
	/** Catalog id ("provider/model") the session open requested; always registered. */
	requestModel?: string;
}

export interface AgentConfigResult {
	/**
	 * Snapshot of the generated auth.json (bytes + external mtime at open),
	 * or null when reuse is off or no external auth exists. Passed back to
	 * syncAuthBackToExternal on close.
	 */
	externalAuth: { authJson: string; stamp: string } | null;
}

function mtimeOf(file: string): string | null {
	try {
		return String(statSync(file).mtimeMs);
	} catch {
		return null;
	}
}

/**
 * Writes the generated pi config into `dir` (the shared probe dir or a
 * per-session agent dir). Manual entries win over merged external ones on id
 * conflicts, mirroring the old in-process registerProvider layering.
 */
export async function writeAgentConfig(
	dir: string,
	values: AutumnSettings,
	options: WriteAgentConfigOptions = {},
): Promise<AgentConfigResult> {
	mkdirSync(dir, { recursive: true });

	// Credential values are pi's Credential shape (api_key or oauth with
	// refresh tokens) — external entries are copied verbatim so the session
	// child can use and refresh them; syncAuthBackToExternal propagates the
	// rotated tokens. Only manual entries are constructed here.
	const auth: Record<string, unknown> = {};
	const models: { providers: Record<string, unknown> } = { providers: {} };
	let externalAuthStamp: string | null = null;

	// 1. External config as baseline (reuse toggle).
	if (values.reuseExternalPi === true) {
		externalAuthStamp = mtimeOf(externalAuthPath());
		if (externalAuthStamp && existsSync(externalAuthPath())) {
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
				if (typeof extModels?.providers === "object" && extModels.providers !== null) {
					Object.assign(models.providers, extModels.providers);
				}
			} catch {}
		}
	}

	// 2. Manual provider entries on top.
	const [requestProvider, requestModelId] = options.requestModel?.split("/", 2) ?? [];
	for (const entry of values.providers) {
		if (!entry.enabled) continue;
		if (!isKnownProviderType(entry.type) && !entry.baseUrl?.trim()) continue;

		if (isKnownProviderType(entry.type)) {
			if (entry.apiKey.trim()) {
				auth[entry.type] = { type: "api_key", key: entry.apiKey.trim() };
			}
			if (entry.baseUrl.trim()) {
				const existing = models.providers[entry.type];
				models.providers[entry.type] = {
					...(typeof existing === "object" && existing !== null ? (existing as object) : {}),
					name: entry.name || entry.type,
					baseUrl: entry.baseUrl.trim(),
				};
			}
		} else {
			const baseUrl = entry.baseUrl.trim();
			// Manual entries beat discovery: a user-listed model is registered
			// even when the endpoint's /v1/models is broken, slow, or hangs.
			const discovered = await probeOpenAiModels(baseUrl, entry.apiKey || undefined);
			const modelIds = [...new Set([...(entry.models ?? []), ...discovered])];
			if (modelIds.length === 0) modelIds.push(DEFAULT_CUSTOM_MODEL_ID);
			if (requestProvider === entry.id && requestModelId && !modelIds.includes(requestModelId)) {
				modelIds.push(requestModelId);
			}
			models.providers[entry.id] = {
				name: entry.name || entry.id,
				baseUrl,
				api: "openai-completions",
				// A credential must exist or pi's get_available_models filters the
				// provider out entirely; keyless custom entries get a dummy so
				// their models still reach the catalog (calls fail with a clear
				// auth error — same as the old in-process runtime overlay).
				apiKey: entry.apiKey.trim() || "dummy-key",
				// reasoning: true makes pi's OpenAI-completions adapter send
				// reasoning_effort for low/medium/high and omit it for off.
				models: modelIds.map((id) => customModelDefinition(id, entry.reasoning === true)),
			};
		}
	}

	const authText = JSON.stringify(auth, null, 2);
	writeFileSync(join(dir, "auth.json"), authText, "utf8");
	chmodSync(join(dir, "auth.json"), 0o600);
	writeFileSync(join(dir, "models.json"), JSON.stringify(models, null, 2), "utf8");

	// 3. mcp.json — pi reads MCP servers from the agent dir (no --mcp-config
	// flag in pi 1.0.0). The catalog probe writes an empty map so the probe
	// child never tries to connect workspace MCP servers.
	const piMcpServers: Record<string, unknown> = {};
	for (const [name, config] of Object.entries(options.mcpServers ?? {})) {
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
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: piMcpServers }, null, 2), "utf8");

	return { externalAuth: externalAuthStamp ? { authJson: authText, stamp: externalAuthStamp } : null };
}

/**
 * Propagates OAuth token refreshes from a closed session's private auth copy
 * back to the external auth.json. The session child works on a private copy
 * (a symlink would be destroyed by pi's atomic rename-on-write), so without
 * this the user's earlier "allow refresh writes" choice would silently lose
 * rotated tokens. Three guards keep this to real rotations only:
 * the child must actually have rewritten its private copy, external pi must
 * not have written the file during the session (mtime guard — external wins),
 * and formatting-only differences are not rotations.
 */
export function syncAuthBackToExternal(
	sessionDir: string,
	externalAuth: { authJson: string; stamp: string } | null,
	reuseExternalPi: boolean,
): void {
	if (!reuseExternalPi || !externalAuth) return;
	try {
		const privatePath = join(sessionDir, "auth.json");
		if (!existsSync(privatePath) || !existsSync(externalAuthPath())) return;
		const privateNow = readFileSync(privatePath, "utf8");
		if (privateNow === externalAuth.authJson) return;
		if (mtimeOf(externalAuthPath()) !== externalAuth.stamp) return;
		// Unparseable content never propagates: a child that crashed mid-write
		// must not corrupt the external credential file.
		const canonical = (text: string): string | null => {
			try {
				return JSON.stringify(JSON.parse(text));
			} catch {
				return null;
			}
		};
		const canonicalPrivate = canonical(privateNow);
		const canonicalExternal = canonical(readFileSync(externalAuthPath(), "utf8"));
		if (!canonicalPrivate || !canonicalExternal) return;
		if (canonicalPrivate === canonicalExternal) return;
		writeFileSync(externalAuthPath(), privateNow, "utf8");
	} catch {
		// Best effort — a failed write-back must not fail the close.
	}
}
