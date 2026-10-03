#!/usr/bin/env node
/**
 * Smoke test for the vendored pi SDK bundle.
 *
 * Replicates the Paseo daemon's plugin-bundle evaluation exactly:
 *   - `globalThis.eval` of the bundle wrapped in `(function(require){...})`,
 *   - a `require` that serves only node builtins (host SDK modules are stubbed),
 *   - no `__filename`, no `__dirname`, no `module`/`exports` globals.
 *
 * Then exercises the embedded-session path: ModelRuntime with a local-only
 * provider, createAgentSession with an in-memory session, event subscribe,
 * dispose. No network, no LLM call.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isBuiltin } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { ensureVendorBundle } from "./lib/ensure-vendor.mjs";

ensureVendorBundle();

const root = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(root, "..", "server", "pi-sdk.cjs");
const bundle = readFileSync(bundlePath, "utf8");

// Paseo's server bundle evaluator (packages/server/src/server/plugins/bundle-evaluator.ts)
// serves host SDK modules + zod from live imports and falls back to a createRequire
// anchored at the server package. Here the SDK is bundled in, so any non-builtin
// fallback require is a bundling leak — make it fail loudly instead.
const nodeRequire = createRequire(import.meta.url);
function runtimeRequire(name) {
	if (isBuiltin(name)) return nodeRequire(name);
	throw new Error(`vendor bundle leaked a runtime dependency: ${name}`);
}

const wrapper = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${bundle}\nreturn module.exports;\n})`;

let sdk;
try {
	const evaluate = globalThis.eval;
	const factory = evaluate(wrapper);
	sdk = factory(runtimeRequire);
} catch (error) {
	console.error("FAIL: bundle evaluation threw:", error);
	process.exit(1);
}

for (const expected of ["createAgentSession", "AgentSession", "ModelRuntime", "SessionManager", "SettingsManager", "DefaultResourceLoader", "McpClient", "StdioTransport", "StreamableHttpTransport"]) {
	if (typeof sdk[expected] !== "function") {
		console.error(`FAIL: export missing: ${expected}`);
		process.exit(1);
	}
}
console.log("PASS: bundle evaluated in Paseo-style eval context; all exports present");

const cwd = mkdtempSync(join(tmpdir(), "autumn-smoke-"));
const modelRuntime = await sdk.ModelRuntime.create({
	modelsPath: null,
	allowModelNetwork: false,
	refreshOnCreate: false,
});
modelRuntime.registerProvider("smoke-provider", {
	name: "Smoke Provider",
	baseUrl: "http://127.0.0.1:9/v1",
	api: "openai-completions",
	models: [
		{
			id: "smoke-model",
			name: "Smoke Model",
			contextWindow: 8192,
			maxTokens: 1024,
			reasoning: false,
			input: ["text"],
		},
	],
});
await modelRuntime.setRuntimeApiKey("smoke-provider", "smoke-key");
const model = modelRuntime.getModel("smoke-provider", "smoke-model");
if (!model) {
	console.error("FAIL: getModel returned undefined for registered provider");
	process.exit(1);
}

let eventCount = 0;
const { session } = await sdk.createAgentSession({
	cwd,
	model,
	modelRuntime,
	sessionManager: sdk.SessionManager.inMemory(cwd),
});
const unsubscribe = session.subscribe(() => {
	eventCount++;
});
console.log("PASS: createAgentSession constructed an embedded session (no TUI, no CLI)");
unsubscribe();
session.dispose();
console.log(`PASS: subscribe/dispose clean (events observed: ${eventCount})`);
console.log("SMOKE TEST OK");
