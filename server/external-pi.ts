import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runnerScriptPath } from "./paths.js";

/**
 * The user's EXTERNAL pi installation. Computed directly — never via pi's
 * getAgentDir(), because the plugin subprocess sets PI_CODING_AGENT_DIR to
 * the plugin's private agent dir for session isolation. An env override
 * exists for nonstandard installs and tests.
 */
export function externalAgentDir(): string {
	const override = process.env.AUTUMN_EXTERNAL_PI_DIR;
	if (override && override.trim()) return override.trim();
	return join(homedir(), ".pi", "agent");
}

export function externalAuthPath(): string {
	return join(externalAgentDir(), "auth.json");
}

export function externalModelsPath(): string {
	return join(externalAgentDir(), "models.json");
}

export interface ExternalModelInfo {
	id: string;
	name: string;
	reasoning?: boolean;
	contextWindow?: number;
}

export interface ExternalProviderInfo {
	id: string;
	/** Which agent source this was detected from ("external-pi" today; more later). */
	source: string;
	name: string;
	authSource: string;
	baseUrl?: string;
	models: ExternalModelInfo[];
}

export interface ExternalDetection {
	agentDir: string;
	providers: ExternalProviderInfo[];
}

/** mtime pair of the two external config files; changes invalidate the cache. */
export function configStamp(): string {
	const stamp = (file: string) => {
		try {
			return String(statSync(file).mtimeMs);
		} catch {
			return "absent";
		}
	};
	return `${stamp(externalAuthPath())}:${stamp(externalModelsPath())}`;
}

let cache: { stamp: string; detection: ExternalDetection } | null = null;

/** External reuse is possible only when at least one config file exists. */
export function hasExternalConfig(): boolean {
	return existsSync(externalAuthPath()) || existsSync(externalModelsPath());
}

/**
 * Enumerate the external pi installation's usable LLM providers.
 * Spawns a fast query to Pi in RPC mode with PI_CODING_AGENT_DIR set to the
 * external directory, grouping available models by provider.
 * Results are cached until the mtime of external config files changes.
 */
export async function detectExternalProviders(): Promise<ExternalDetection> {
	const stamp = configStamp();
	if (cache && cache.stamp === stamp) return cache.detection;

	const detection: ExternalDetection = {
		agentDir: externalAgentDir(),
		providers: [],
	};

	if (hasExternalConfig()) {
		try {
			// Read external auth.json & models.json to extract authSource and baseUrl
			let authJson: Record<string, any> = {};
			let modelsJson: Record<string, any> = {};
			if (existsSync(externalAuthPath())) {
				try {
					authJson = JSON.parse(readFileSync(externalAuthPath(), "utf8"));
				} catch {}
			}
			if (existsSync(externalModelsPath())) {
				try {
					modelsJson = JSON.parse(readFileSync(externalModelsPath(), "utf8"));
				} catch {}
			}

			const available = await queryAvailableModelsFromDir(externalAgentDir());
			const grouped = new Map<string, ExternalModelInfo[]>();

			for (const model of available) {
				const list = grouped.get(model.provider) ?? [];
				list.push({
					id: model.id,
					name: model.name || model.id,
					reasoning: model.reasoning,
					contextWindow: model.contextWindow,
				});
				grouped.set(model.provider, list);
			}

			for (const [providerId, models] of grouped) {
				const customProvider = modelsJson.providers?.[providerId];
				const authEntry = authJson[providerId];

				let authSource = "stored";
				if (authEntry?.type === "oauth") {
					authSource = "oauth";
				} else if (customProvider?.apiKey) {
					authSource = "models_json_key";
				} else if (authEntry?.key) {
					authSource = "stored";
				}

				detection.providers.push({
					id: providerId,
					source: "external-pi",
					name: customProvider?.name || providerId,
					authSource,
					baseUrl: customProvider?.baseUrl,
					models,
				});
			}
		} catch {
			// Unreadable external config degrades to empty
		}
	}

	cache = { stamp, detection };
	return detection;
}

/** External provider id → display name, for catalog row descriptions. */
export async function externalProviderLabels(): Promise<Record<string, string>> {
	const detection = await detectExternalProviders();
	const labels: Record<string, string> = {};
	for (const provider of detection.providers) {
		labels[provider.id] = provider.name || provider.id;
	}
	return labels;
}

/**
 * Spawns a short-lived Pi process pointing to a specific agentDir
 * to query available models via `get_available_models`.
 */
async function queryAvailableModelsFromDir(
	targetAgentDir: string,
): Promise<Array<{ id: string; provider: string; name?: string; reasoning?: boolean; contextWindow?: number }>> {
	return new Promise((resolve) => {
		let resolved = false;
		const child = spawn(
			process.execPath,
			[runnerScriptPath(), "--mode", "rpc", "--no-session"],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, PI_CODING_AGENT_DIR: targetAgentDir },
			},
		);

		const cleanup = (result: any[]) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			try {
				child.stdin.end();
				child.kill("SIGTERM");
			} catch {}
			resolve(result);
		};

		const timer = setTimeout(() => cleanup([]), 6000);

		let buffer = "";
		child.stdout.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line) {
					try {
						const msg = JSON.parse(line);
						if (msg.id === "detect-1" && Array.isArray(msg.data?.models)) {
							cleanup(msg.data.models);
							return;
						}
					} catch {}
				}
				idx = buffer.indexOf("\n");
			}
		});

		child.on("error", () => cleanup([]));
		child.on("exit", () => cleanup([]));

		child.stdin.write(`${JSON.stringify({ id: "detect-1", type: "get_available_models" })}\n`);
	});
}
