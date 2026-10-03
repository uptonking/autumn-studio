import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Plugin-owned data root. The plugin subprocess inherits the daemon's
 * environment, so PASEO_HOME resolves to the same home the daemon writes to
 * (dev checkouts set it to <repo>/.dev/paseo-home; the packaged daemon uses
 * ~/.paseo). Nothing outside this tree is written; nothing inside the user's
 * external `~/.pi/agent` is ever read by the embedded agent.
 */
export function pluginDataDir(): string {
	const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
	return join(paseoHome, "plugin-data", "autumn-studio");
}

export function sessionsDir(): string {
	return join(pluginDataDir(), "sessions");
}

export function agentDir(): string {
	return join(pluginDataDir(), "agent-dir");
}

/**
 * Path to server/pi-runner.mjs, which runs Pi in RPC mode as a standard Node.js
 * subprocess.
 */
export function runnerScriptPath(): string {
	if (process.env.AUTUMN_PI_RUNNER && existsSync(process.env.AUTUMN_PI_RUNNER)) {
		return process.env.AUTUMN_PI_RUNNER;
	}
	const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
	const candidates = [
		process.env.AUTUMN_PLUGIN_ROOT ? join(process.env.AUTUMN_PLUGIN_ROOT, "server", "pi-runner.mjs") : null,
		join(process.cwd(), "server", "pi-runner.mjs"),
		join(process.cwd(), "autumn-studio", "server", "pi-runner.mjs"),
		join(paseoHome, "plugins", "autumn-studio", "server", "pi-runner.mjs"),
		"/Users/yaoo/Documents/repos/ai-ml-llm/all-agi-harness/autumn-studio/server/pi-runner.mjs",
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	throw new Error("Could not find server/pi-runner.mjs");
}
