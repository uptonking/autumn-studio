#!/usr/bin/env node
/**
 * Provider-level integration test.
 *
 * Compiles the plugin with the REAL Paseo plugin compiler, evaluates the
 * bundle in the daemon-style eval context, and drives the contributed
 * provider end-to-end — sessions run as real pi RPC child processes —
 * against a mock OpenAI-compatible LLM server:
 *
 *   status → catalog (probe spawn + /v1/models discovery) → session.open
 *   (pi child spawns with generated per-session config) →
 *   prompt 1: bash tool executed for real (env overlay reaches the child),
 *             streamed text answer, usage, persistence to a pi session file →
 *   prompt 2: read tool (detail mapping) with a reasoning delta →
 *   prompt 3: session.interrupt mid-stream → turn canceled →
 *   prompt 4: completes →
 *   session.close → reopen with persistence + history "replay" →
 *   the stored conversation is replayed as timeline items.
 *
 * Everything isolated under a temp PASEO_HOME; nothing touches ~/.paseo.
 *
 * Run: node scripts/integration-test.mjs <path-to-paseo-repo>
 * Requires the paseo repo to have `npm install` + `npm run build:client` +
 * `npm run build:server` done.
 */
import { createRequire, isBuiltin } from "node:module";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, statSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(root);
const paseoRoot = resolve(process.argv[2] ?? join(pluginRoot, "..", "paseo"));

// The plugin locates its own runner via AUTUMN_PLUGIN_ROOT under test.
process.env.AUTUMN_PLUGIN_ROOT = pluginRoot;

// Isolated data dirs for the whole test.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "autumn-integration-"));
const seededBaseUrl = "http://127.0.0.1:2/v1";
mkdirSync(join(process.env.PASEO_HOME, "plugin-data", "autumn-studio"), { recursive: true });

// Fake external pi installation: auth.json key for a builtin provider plus a
// custom models.json provider pointing at the mock LLM.
const extAgentDir = mkdtempSync(join(tmpdir(), "autumn-ext-pi-"));
writeFileSync(
	join(extAgentDir, "auth.json"),
	JSON.stringify({ openai: { type: "api_key", key: "sk-external-test" } }),
);
writeFileSync(
	join(extAgentDir, "models.json"),
	JSON.stringify({
		providers: {
			"ext-provider": {
				name: "Ext Provider",
				baseUrl: "SET_AFTER_MOCK_PORT",
				apiKey: "ext-key",
				api: "openai-completions",
				models: [
					{
						id: "ext-model-a",
						name: "Ext Model A",
						contextWindow: 8192,
						maxTokens: 2048,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
process.env.AUTUMN_EXTERNAL_PI_DIR = extAgentDir;
const externalSnapshot = () => readdirSync(extAgentDir).sort().join(",");
const externalAuthBefore = readFileSync(join(extAgentDir, "auth.json"), "utf8");
const require2 = createRequire(import.meta.url);
const cwd = mkdtempSync(join(tmpdir(), "autumn-cwd-"));
const readFile = join(cwd, "mock-read.txt");
writeFileSync(readFile, "mock-read-content-line\n");

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible LLM server
// ---------------------------------------------------------------------------

let llmCalls = 0;
const llmBodies = [];

function chunk(id, index, delta, finish = null, extra = {}) {
	return {
		id,
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "mock-small",
		choices: [{ index, delta, finish_reason: finish }],
		...extra,
	};
}

/** Last user message text of a chat-completions request body. */
function lastUserText(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			return message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
		}
	}
	return "";
}

function sse(res, chunks, intervalMs = 15) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	let i = 0;
	const write = () => {
		if (res.destroyed || res.writableEnded) return;
		if (i >= chunks.length) {
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}
		res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
		i++;
		setTimeout(write, intervalMs);
	};
	write();
}

const server = http.createServer((req, res) => {
	res.on("error", () => {});
	if (req.method === "GET" && req.url?.endsWith("/models")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: [{ id: "mock-small" }, { id: "mock-large" }],
			}),
		);
		return;
	}
	if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			llmCalls++;
			let parsed = {};
			try {
				parsed = JSON.parse(body);
			} catch {}
			llmBodies.push(parsed);
			const id = `chatcmpl-${llmCalls}`;
			const call = (n) => ({
				index: 0,
				id: `call-${n}`,
				type: "function",
				function: { name: "", arguments: "" },
			});

			if (llmCalls === 1) {
				// Turn 1: ask for the bash tool, then stop for its result. The
				// command also echoes the session env marker — the tool spawns
				// inside the pi child, so this proves the env overlay arrives.
				sse(res, [
					chunk(id, 0, { role: "assistant", content: "" }),
					chunk(id, 0, { tool_calls: [{ ...call(1), function: { name: "bash", arguments: "" } }] }),
					chunk(id, 0, { tool_calls: [{ index: 0, function: { arguments: '{"command":"echo integration-tool-ok $AUTUMN_TEST_ENV_MARKER"}' } }] }),
					chunk(id, 0, {}, "tool_calls"),
				]);
				return;
			}
			if (llmCalls === 2) {
				// Turn 2: read tool + a reasoning delta before the call.
				sse(res, [
					chunk(id, 0, { role: "assistant", content: "" }),
					chunk(id, 0, { reasoning_content: "thinking-hard" }),
					chunk(id, 0, { tool_calls: [{ ...call(2), function: { name: "read", arguments: "" } }] }),
					chunk(id, 0, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readFile }) } }] }),
					chunk(id, 0, {}, "tool_calls"),
				]);
				return;
			}
			if (lastUserText(parsed).includes("keep going")) {
				// Slow stream for the interrupt and close-mid-turn scenarios.
				const chunks = [chunk(id, 0, { role: "assistant", content: "" })];
				for (let i = 0; i < 24; i++) chunks.push(chunk(id, 0, { content: "x" }));
				sse(res, chunks, 250);
				return;
			}
			// Any later turn: streamed text answer with usage.
			sse(res, [
				chunk(id, 0, { role: "assistant", content: "" }),
				chunk(id, 0, { content: "integration-" }),
				chunk(id, 0, { content: "done" }),
				chunk(id, 0, {}, "stop", { usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } }),
			]);
		});
		return;
	}
	res.writeHead(404);
	res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const mockPort = server.address().port;
console.log(`mock LLM server on 127.0.0.1:${mockPort}`);

// Seed the persisted discovery cache: an entry the mock's /v1/models no
// longer reports (the merge-on-success path must keep it) plus a
// last-known-good list for the unreachable p3 endpoint.
writeFileSync(
	join(process.env.PASEO_HOME, "plugin-data", "autumn-studio", "discovery-cache.json"),
	JSON.stringify({
		endpoints: {
			[seededBaseUrl]: ["seeded-model"],
			[`http://127.0.0.1:${mockPort}/v1`]: ["historical-model"],
		},
	}),
);

writeFileSync(
	join(extAgentDir, "models.json"),
	JSON.stringify({
		providers: {
			"ext-provider": {
				name: "Ext Provider",
				baseUrl: `http://127.0.0.1:${mockPort}/v1`,
				apiKey: "ext-key",
				api: "openai-completions",
				models: [
					{
						id: "ext-model-a",
						name: "Ext Model A",
						contextWindow: 8192,
						maxTokens: 2048,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);

// ---------------------------------------------------------------------------
// Compile + evaluate the real plugin bundle
// ---------------------------------------------------------------------------

const compiler = await import(
	pathToFileURL(join(paseoRoot, "packages/server/dist/server/server/plugins/compiler.js")).href
);
console.log("compiling plugin with the real Paseo compiler…");
const { serverBundle } = await compiler.compilePlugin({
	server: join(pluginRoot, "index.server.ts"),
	client: null,
});

const nodeRequire = createRequire(import.meta.url);
function runtimeRequire(name) {
	if (name === "@getpaseo/plugin") return require2(join(paseoRoot, "packages/plugin/dist/index.js"));
	if (name === "@getpaseo/plugin/server") return require2(join(paseoRoot, "packages/plugin/dist/server/index.js"));
	if (name === "@getpaseo/plugin/server/provider") return require2(join(paseoRoot, "packages/plugin/dist/server/provider.js"));
	if (name === "zod") return require2("zod");
	if (isBuiltin(name)) return nodeRequire(name);
	throw new Error(`bundle leaked a runtime dependency: ${name}`);
}

// Fake settings store backed by an in-memory document, like the host serves.
const settingsValues = {
	enabled: true,
	reuseExternalPi: true,
	defaultThinkingLevel: "medium",
	customInstructions: "",
	providers: [
		{
			id: "p1",
			name: "Mock LLM",
			type: "custom",
			apiKey: "mock-key",
			baseUrl: `http://127.0.0.1:${mockPort}/v1`,
			models: ["gpt-6-luna"],
			reasoning: true,
			enabled: true,
		},
		{
			// Unreachable endpoint: discovery must fail without breaking the
			// entry — its manual models must still reach the catalog.
			id: "p2",
			name: "Dead Endpoint",
			type: "custom",
			apiKey: "",
			baseUrl: "http://127.0.0.1:1/v1",
			models: ["local-mock"],
			reasoning: false,
			enabled: true,
		},
		{
			// Unreachable endpoint with NO manual models: the persisted
			// last-known-good discovery cache must supply its model.
			id: "p3",
			name: "Seeded Endpoint",
			type: "custom",
			apiKey: "",
			baseUrl: seededBaseUrl,
			models: [],
			reasoning: false,
			enabled: true,
		},
	],
};
const settingsHandle = {
	async read() {
		return { status: "ready", revision: "test-rev-1", values: settingsValues };
	},
	subscribe() {
		return () => {};
	},
};

let provider;
const evaluate = globalThis.eval;
const exportsObject = evaluate(serverBundle)(runtimeRequire);
const setup = typeof exportsObject === "object" && exportsObject !== null ? exportsObject.default : exportsObject;
const rpcHandlers = new Map();
setup({
	registerProvider(p) {
		provider = p;
	},
	registerSettings() {
		return settingsHandle;
	},
	handle(contract, handler) {
		rpcHandlers.set(contract.name, handler);
	},
});

function fail(message) {
	console.error(`FAIL: ${message}`);
	server.close();
	process.exit(1);
}

if (!provider) fail("provider was not registered");
console.log(`PASS: provider registered: id=${provider.id} (command: ${provider.command ? "set" : "none, embedded"})`);

// status()/cache-key must honor external providers even with no manual entries.
{
	const originalProviders = settingsValues.providers;
	settingsValues.providers = [];
	const externalOnlyStatus = await provider.status();
	if (!externalOnlyStatus.available) {
		fail(`status() unavailable with only external providers: ${externalOnlyStatus.diagnostic}`);
	}
	const keyA = await provider.getCatalogCacheKey({});
	// Touch the external models.json (valid content, new mtime) — the cache
	// key must change so the catalog refreshes after external config edits.
	const modelsJsonNow = readFileSync(join(extAgentDir, "models.json"), "utf8");
	writeFileSync(join(extAgentDir, "models.json"), `${modelsJsonNow}\n`);
	const keyB = await provider.getCatalogCacheKey({});
	settingsValues.providers = originalProviders;
	if (keyA === keyB) fail("catalog cache key ignored an external config change");
	console.log("PASS: status() and cache key honor external Pi config");
}

// ---------------------------------------------------------------------------
// Drive the provider
// ---------------------------------------------------------------------------

/** PIDs of running pi runner children (pgrep exits 1 when there are none). */
function listPiChildren() {
	try {
		return execSync("pgrep -f pi-runner.mjs", { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}
// Baseline may include unrelated runner processes from the user's real daemon;
// only deltas count as orphans.
const piChildrenBaseline = listPiChildren();

const status = await provider.status();
if (!status.available) fail(`status() reported unavailable: ${status.diagnostic}`);
console.log("PASS: status() reports available");

const connection = await provider.connect({
	versions: [1],
	capabilities: ["prompt.message", "prompt.steer", "session.configure", "session.persistence"],
});
const events = [];
connection.onEvent((event) => events.push(event));

function waitFor(description, predicate, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const check = () => {
			const found = events.find(predicate);
			if (found) {
				resolve(found);
				return;
			}
			if (Date.now() - started > timeoutMs) {
				reject(new Error(`timeout waiting for ${description}; events so far: ${events.map((e) => e.type).join(",")}`));
				return;
			}
			setTimeout(check, 25);
		};
		check();
	});
}

function openSession(sessionId, model, persistence) {
	connection.send({
		type: "session.open",
		requestId: `req-open-${sessionId}`,
		sessionId,
		history: persistence ? "replay" : "skip",
		...(persistence ? { persistence } : {}),
		config: {
			cwd,
			// Reaches the pi child's spawn env: the bash tool run in prompt 1
			// proves the session env overlay actually arrives in the child.
			env: { AUTUMN_TEST_ENV_MARKER: "env-overlay-works" },
			mcpServers: {},
			model,
			settings: {},
			persist: true,
		},
	});
}

function prompt(sessionId, clientMessageId, text, delivery = "auto") {
	connection.send({
		type: "session.prompt",
		sessionId,
		prompt: {
			clientMessageId,
			delivery,
			input: { type: "message", content: [{ type: "text", text }] },
		},
	});
}

// 1. Catalog with discovery from the mock /v1/models endpoint.
connection.send({ type: "catalog", requestId: "req-catalog" });
const catalogEvent = await waitFor("catalog", (e) => e.type === "catalog");
const catalogModelIds = catalogEvent.catalog.models.map((m) => m.id);
if (!catalogModelIds.includes("p1/mock-small") || !catalogModelIds.includes("p1/mock-large")) {
	fail(`catalog missing discovered models; got: ${catalogModelIds.join(", ")}`);
}
for (const required of ["p1/mock-small", "p1/mock-large", "p1/gpt-6-luna", "p2/local-mock", "p3/seeded-model", "p1/historical-model"]) {
	if (!catalogModelIds.includes(required)) {
		fail(`catalog missing ${required} (manual ∪ discovered broken); got: ${catalogModelIds.join(", ")}`);
	}
}
console.log("PASS: catalog = discovered ∪ manual models, including an unreachable endpoint's entry");
if (!catalogModelIds.some((id) => id === "ext-provider/ext-model-a")) {
	fail(`external models.json provider missing from catalog; got: ${catalogModelIds.join(", ")}`);
}
if (!catalogModelIds.some((id) => id.startsWith("openai/"))) {
	fail(`external auth.json credential (openai) did not surface builtin models; got: ${catalogModelIds.join(", ")}`);
}
const autoRow = catalogEvent.catalog.models.find((m) => m.id === "ext-provider/ext-model-a");
if (!autoRow?.description?.startsWith("\u{1F441}")) {
	fail(`auto-detected catalog row missing eye marker: ${JSON.stringify(autoRow?.description)}`);
}
const manualRow = catalogEvent.catalog.models.find((m) => m.id === "p1/mock-small");
if (manualRow?.description?.startsWith("\u{1F441}")) {
	fail(`manual catalog row wrongly marked auto: ${JSON.stringify(manualRow.description)}`);
}
console.log("PASS: picker marks auto-detected models (eye) and leaves manual ones clean");
console.log("PASS: external Pi providers (models.json + auth.json) appear in the catalog");

// External-only catalog: when zero manual providers are configured, external models still populate the catalog.
{
	const original = settingsValues.providers;
	settingsValues.providers = [];
	connection.send({ type: "catalog", requestId: "req-catalog-ext-only" });
	const extOnlyEvent = await waitFor("catalog ext-only", (e) => e.type === "catalog" && e.requestId === "req-catalog-ext-only");
	settingsValues.providers = original;
	const extOnlyIds = extOnlyEvent.catalog.models.map((m) => m.id);
	if (!extOnlyIds.some((id) => id === "ext-provider/ext-model-a")) {
		fail(`external-only catalog missing external models; got: ${extOnlyIds.join(", ")}`);
	}
	console.log("PASS: external-only catalog serves external models with zero manual providers");
}
const externalHandler = rpcHandlers.get("autumn-studio.external-providers");
if (!externalHandler) fail("autumn-studio.external-providers RPC not registered");
const externalResult = await externalHandler({});
if (externalResult.agentDir !== extAgentDir) fail(`detection agentDir is ${externalResult.agentDir}`);
const extProvider = externalResult.providers.find((p) => p.id === "ext-provider");
if (!extProvider || extProvider.source !== "external-pi" || extProvider.authSource !== "models_json_key" || extProvider.models.length !== 1) {
	fail(`detection missing ext-provider: ${JSON.stringify(extProvider)}`);
}
const openaiEntry = externalResult.providers.find((p) => p.id === "openai");
if (!openaiEntry || openaiEntry.authSource !== "stored") {
	fail(`detection missing openai (stored): ${JSON.stringify(openaiEntry)}`);
}
console.log("PASS: detection RPC lists external providers with auth sources");
const smallModel = catalogEvent.catalog.models.find((m) => m.id === "p1/mock-small");
if (!smallModel?.thinkingOptions || smallModel.thinkingOptions.length !== 4) {
	fail(`mock-small thinking options missing: ${JSON.stringify(smallModel?.thinkingOptions)}`);
}
if (smallModel.defaultThinkingOptionId !== "medium") {
	fail(`mock-small default thinking option is ${smallModel.defaultThinkingOptionId}, expected "medium" from settings`);
}
if (smallModel.thinkingOptions.find((o) => o.id === "medium")?.isDefault !== true) {
	fail("medium effort not flagged isDefault in catalog thinking options");
}
console.log(`PASS: catalog model carries reasoning efforts with default "${smallModel.defaultThinkingOptionId}"`);

// 2. Session open with selectable models in the config state.
openSession("s1", "p1/mock-small");
await waitFor("session.opened", (e) => e.type === "session.opened" && e.sessionId === "s1");
const configEvent = await waitFor("session.config", (e) => e.type === "session.config" && e.sessionId === "s1");
await waitFor("session.ready", (e) => e.type === "session.ready" && e.sessionId === "s1");
if (!Array.isArray(configEvent.config.models) || configEvent.config.models.length < 2) {
	fail(`session.config models empty (${configEvent.config.models?.length}) — in-session model switcher would be broken`);
}
if (configEvent.config.thinkingOption !== "medium") {
	fail(`session config thinking option is ${configEvent.config.thinkingOption}, expected settings default "medium"`);
}
const configModel = configEvent.config.models.find((m) => m.id === "p1/mock-small");
if (!configModel?.thinkingOptions?.length) fail("session.config model lacks thinking options");
console.log(`PASS: session open; default reasoning effort "${configEvent.config.thinkingOption}" with ${configEvent.config.models.length} selectable models`);

// 3. Steer with no active turn must fail fast.
prompt("s1", "steer-1", "too early", "steer");
const failedSteer = await waitFor("failed steer prompt_result", (e) => e.type === "session.prompt_result" && e.clientMessageId === "steer-1");
if (failedSteer.result.type !== "failed") fail(`steer without active turn returned ${failedSteer.result.type}`);
console.log("PASS: steer without active turn fails fast");

// 4. Prompt 1: bash tool executes for real (with session env), then streamed
// text with usage.
prompt("s1", "msg-1", "Run echo integration-tool-ok, then tell me the output.");
await waitFor("turn started", (e) => e.type === "session.turn" && e.state === "started");
await waitFor("bash tool completed", (e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed" && e.item.name === "bash");
const bashItem = events.find((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed" && e.item.name === "bash");
const bashOutput = bashItem.item.detail.type === "shell" ? bashItem.item.detail.output ?? "" : "";
if (!bashOutput.includes("integration-tool-ok")) fail(`bash tool output missing marker: ${bashOutput.slice(0, 200)}`);
if (!bashOutput.includes("env-overlay-works")) {
	fail(`session env did not reach the pi child's bash spawn: ${bashOutput.slice(0, 200)}`);
}
console.log(`PASS: bash tool executed in the child with session env; output: ${bashOutput.trim().slice(0, 80)}`);

await waitFor("turn 1 completed", (e) => e.type === "session.turn" && e.state === "completed");
if (!events.some((e) => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text.includes("integration-done"))) {
	fail("assistant text missing after turn 1");
}
const usageEvent = events.find((e) => e.type === "session.usage");
if (!usageEvent || !(usageEvent.usage.inputTokens > 0)) fail(`usage missing or zero: ${JSON.stringify(usageEvent?.usage)}`);
console.log(`PASS: turn 1 completed; usage input=${usageEvent.usage.inputTokens} output=${usageEvent.usage.outputTokens}`);
if (llmBodies[0]?.reasoning_effort !== "medium") {
	fail(`first completion reasoning_effort is ${JSON.stringify(llmBodies[0]?.reasoning_effort)}, expected "medium"`);
}
console.log('PASS: reasoning_effort "medium" sent to the endpoint');

// 5. Prompt 2: reasoning delta + read tool detail mapping.
prompt("s1", "msg-2", "Read mock-read.txt.");
await waitFor("turn 2 completed", (e) => e.type === "session.turn" && e.state === "completed" && events.filter((x) => x.type === "session.turn" && x.state === "completed").length >= 2);
if (!events.some((e) => e.type === "timeline.item" && e.item.type === "reasoning" && e.item.text.includes("thinking-hard"))) {
	fail("reasoning item missing for reasoning_content delta");
}
const readItem = events.find((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.name === "read" && e.item.status === "completed");
if (!readItem || readItem.item.detail.type !== "read" || !readItem.item.detail.content?.includes("mock-read-content")) {
	fail(`read tool detail wrong: ${JSON.stringify(readItem?.item.detail)?.slice(0, 200)}`);
}
console.log(`PASS: reasoning mapped; read tool content: ${readItem.item.detail.content.trim().slice(0, 40)}`);

// 6. Prompt 3: interrupt mid-stream → turn canceled.
prompt("s1", "msg-3", "Start talking and keep going.");
const pr3 = await waitFor("prompt_result 3", (e) => e.type === "session.prompt_result" && e.clientMessageId === "msg-3");
if (pr3.result.type !== "turn") fail(`prompt_result 3 returned ${pr3.result.type}`);
const turn3Id = pr3.result.turnId;
await waitFor("turn 3 started", (e) => e.type === "session.turn" && e.turnId === turn3Id && e.state === "started");
// Wait until content is actually streaming before interrupting.
await waitFor("turn 3 streaming", (e) => e.type === "timeline.item" && e.item?.type === "assistant_message" && events.filter((x) => x.type === "timeline.item" && x.item?.type === "assistant_message" && x.sessionId === "s1").length >= 3);
// A second non-steer prompt during the active turn fails fast instead of
// corrupting turn bookkeeping or hanging the dispatch.
prompt("s1", "msg-3b", "Second prompt while streaming.");
const pr3b = await waitFor("concurrent prompt_result", (e) => e.type === "session.prompt_result" && e.clientMessageId === "msg-3b");
if (pr3b.result.type !== "failed") fail(`concurrent prompt returned ${pr3b.result.type}, expected failed`);
console.log("PASS: concurrent prompt during an active turn fails fast");
connection.send({ type: "session.interrupt", requestId: "req-interrupt", sessionId: "s1" });
const canceled = await waitFor("turn 3 canceled", (e) => e.type === "session.turn" && e.turnId === turn3Id && (e.state === "canceled" || e.state === "completed" || e.state === "failed"));
if (canceled.state !== "canceled") fail(`interrupted turn ended as ${canceled.state}, expected canceled`);
console.log("PASS: interrupt mid-stream → turn canceled");

// 7. Switch the reasoning effort to high, then run a clean turn after the cancel.
connection.send({
	type: "session.configure",
	requestId: "req-effort",
	sessionId: "s1",
	changes: { thinkingOption: "high" },
});
await waitFor("config effort high", (e) => e.type === "session.config" && e.sessionId === "s1" && e.config.thinkingOption === "high");
console.log('PASS: reasoning effort switched to "high" mid-session');
const callCountBeforeTurn4 = llmCalls;
prompt("s1", "msg-4", "Summarize.");
await waitFor("turn 4 completed", (e) => e.type === "session.turn" && e.state === "completed" && events.filter((x) => x.type === "session.turn" && x.state === "completed").length >= 3);
console.log("PASS: clean turn completes after cancel");
const efforts = llmBodies.map((b, i) => `#${i + 1}:${b.reasoning_effort ?? "(none)"}`).join(" ");
const turn4Body = llmBodies[callCountBeforeTurn4];
if (turn4Body?.reasoning_effort !== "high") {
	fail(`post-switch reasoning_effort is ${JSON.stringify(turn4Body?.reasoning_effort)}, expected "high"; all calls: ${efforts}`);
}
console.log('PASS: reasoning_effort "high" sent after the switch');

// 8. Persistence: a real session file must exist on disk.
const persistenceEvent = events.filter((e) => e.type === "session.persistence").at(-1);
const sessionFile = persistenceEvent?.persistence?.data?.sessionFile;
if (typeof sessionFile !== "string" || !existsSync(sessionFile)) {
	fail(`session file not persisted: ${sessionFile}`);
}
if (statSync(sessionFile).size === 0) fail("session file is empty");
console.log(`PASS: session persisted (${statSync(sessionFile).size} bytes)`);

// 9. Model switch mid-session.
connection.send({
	type: "session.configure",
	requestId: "req-config",
	sessionId: "s1",
	changes: { model: "p1/mock-large" },
});
await waitFor("session.config after configure", (e) => e.type === "session.config" && e.sessionId === "s1" && e.config.model === "p1/mock-large");
console.log("PASS: model switched to p1/mock-large");

// 10. Close, then restore with replay.
connection.send({ type: "session.close", requestId: "req-close-1", sessionId: "s1" });
await waitFor("session.closed", (e) => e.type === "session.closed");
console.log("PASS: session closed");

const userMessagesBefore = events.filter((e) => e.type === "timeline.item" && e.item.type === "user_message").length;
openSession("s2", "p1/mock-large", { version: 1, data: { sessionFile, nativeSessionId: "s1" } });
await waitFor("s2 opened", (e) => e.type === "session.opened" && e.sessionId === "s2");
await waitFor("s2 ready", (e) => e.type === "session.ready" && e.sessionId === "s2");

const s2Items = events.filter((e) => e.type === "timeline.item" && e.sessionId === "s2" && e.item?.type);
const replayUsers = s2Items.filter((e) => e.item.type === "user_message").length;
const replayAssistants = s2Items.filter((e) => e.item.type === "assistant_message").length;
const replayTools = s2Items.filter((e) => e.item.type === "tool_call").length;
const replayReasoning = s2Items.filter((e) => e.item.type === "reasoning").length;
if (replayUsers < userMessagesBefore) fail(`replay users ${replayUsers} < ${userMessagesBefore}`);
if (replayAssistants < 1) fail("replay assistants empty");
if (replayTools < 2) fail(`replay tool calls ${replayTools} < 2`);
if (replayReasoning < 1) fail("replay reasoning missing");
console.log(`PASS: replay restored ${replayUsers} user / ${replayAssistants} assistant / ${replayTools} tool / ${replayReasoning} reasoning items`);

// 11. The restored session still prompts.
prompt("s2", "msg-5", "Final check.");
await waitFor("s2 turn completed", (e) => e.type === "session.turn" && e.state === "completed" && e.sessionId === "s2");
console.log("PASS: restored session accepts prompts");

connection.send({ type: "session.close", requestId: "req-close-2", sessionId: "s2" });
await waitFor("s2 closed", (e) => e.type === "session.closed" && e.sessionId === "s2");
console.log("PASS: restored session closed");

// 12. Close during an active turn: dispose must unwind promptly, emit nothing
// for the dead session afterwards, and leave the connection usable.
openSession("s3", "p1/mock-small");
await waitFor("s3 ready", (e) => e.type === "session.ready" && e.sessionId === "s3");
prompt("s3", "msg-6", "Start talking and keep going.");
await waitFor("s3 turn started", (e) => e.type === "session.turn" && e.state === "started" && e.sessionId === "s3");
await waitFor("s3 streaming", (e) => e.type === "timeline.item" && e.item?.type === "assistant_message" && e.sessionId === "s3");
connection.send({ type: "session.close", requestId: "req-close-3", sessionId: "s3" });
await waitFor("s3 closed", (e) => e.type === "session.closed" && e.sessionId === "s3");
const s3EventsAtClose = events.filter((e) => e.sessionId === "s3").length;
await new Promise((resolve) => setTimeout(resolve, 500));
const s3EventsAfter = events.filter((e) => e.sessionId === "s3").length;
if (s3EventsAfter !== s3EventsAtClose) {
	fail(`s3 emitted ${s3EventsAfter - s3EventsAtClose} events after close`);
}
console.log("PASS: close mid-turn unwinds cleanly with no post-close events");

// 13. The connection still works after the mid-turn close.
openSession("s4", "p1/mock-small");
await waitFor("s4 ready", (e) => e.type === "session.ready" && e.sessionId === "s4");
prompt("s4", "msg-7", "Summarize.");
await waitFor("s4 turn completed", (e) => e.type === "session.turn" && e.state === "completed" && e.sessionId === "s4");
connection.send({ type: "session.close", requestId: "req-close-4", sessionId: "s4" });
await waitFor("s4 closed", (e) => e.type === "session.closed" && e.sessionId === "s4");
console.log("PASS: connection usable after mid-turn close");

// 14. A model from the external models.json provider streams for real
// (proves the external provider's key is used end-to-end).
openSession("s5", "ext-provider/ext-model-a");
await waitFor("s5 ready", (e) => e.type === "session.ready" && e.sessionId === "s5");
prompt("s5", "msg-8", "External check.");
await waitFor("s5 turn completed", (e) => e.type === "session.turn" && e.state === "completed" && e.sessionId === "s5");
if (!events.some((e) => e.type === "timeline.item" && e.item?.type === "assistant_message" && e.sessionId === "s5" && e.item.text.includes("integration-done"))) {
	fail("external-model session produced no assistant text");
}
connection.send({ type: "session.close", requestId: "req-close-5", sessionId: "s5" });
await waitFor("s5 closed", (e) => e.type === "session.closed" && e.sessionId === "s5");
console.log("PASS: external models.json model streams through the mock");

// 15. Stale-model resilience: a requested model the child cannot resolve
// must not kill the session open. pi 1.0.0 warns and substitutes a synthetic
// custom model id; stricter pi versions exit(1) at launch, which the plugin's
// handshake fallback covers by respawning without the launch model flags.
// Either way the session opens and prompts.
openSession("s6", "ext-provider/missing-model");
await waitFor("s6 opened", (e) => e.type === "session.opened" && e.sessionId === "s6");
const s6Config = await waitFor("s6 config", (e) => e.type === "session.config" && e.sessionId === "s6");
await waitFor("s6 ready", (e) => e.type === "session.ready" && e.sessionId === "s6");
prompt("s6", "msg-9", "Summarize.");
await waitFor("s6 turn completed", (e) => e.type === "session.turn" && e.state === "completed" && e.sessionId === "s6");
connection.send({ type: "session.close", requestId: "req-close-6", sessionId: "s6" });
await waitFor("s6 closed", (e) => e.type === "session.closed" && e.sessionId === "s6");
console.log(`PASS: unresolvable requested model still yields a working session (model=${s6Config.config.model ?? "default"})`);

// 16. Anchorless plugin-root resolution: an install whose manifest build
// step never ran (e.g. a reload, which recompiles without running the build)
// has no plugin-root.json anchor and no AUTUMN_PLUGIN_ROOT. The plugin must
// discover its directory from the daemon's plugin registry in
// $PASEO_HOME/config.json and self-heal the anchor for subsequent
// resolutions. A settings change forces a fresh catalog build (memo key
// changes), which spawns a probe child and therefore resolves the root.
{
	const anchorlessHome = mkdtempSync(join(tmpdir(), "autumn-anchorless-"));
	const anchorlessDataDir = join(anchorlessHome, "plugin-data", "autumn-studio");
	mkdirSync(anchorlessDataDir, { recursive: true });
	writeFileSync(
		join(anchorlessHome, "config.json"),
		JSON.stringify({
			plugins: { "autumn-studio": { source: "directory", path: pluginRoot, enabled: true } },
		}),
	);
	const prevHome = process.env.PASEO_HOME;
	const prevRoot = process.env.AUTUMN_PLUGIN_ROOT;
	process.env.PASEO_HOME = anchorlessHome;
	delete process.env.AUTUMN_PLUGIN_ROOT;
	try {
		const originalProviders = settingsValues.providers;
		settingsValues.providers = [
			...originalProviders,
			{
				id: "p-anchor",
				name: "Anchorless Endpoint",
				type: "custom",
				apiKey: "",
				baseUrl: seededBaseUrl,
				models: [],
				reasoning: false,
				enabled: true,
			},
		];
		connection.send({ type: "catalog", requestId: "req-catalog-anchorless" });
		const anchorlessEvent = await waitFor(
			"anchorless catalog",
			(e) => e.type === "catalog" && e.requestId === "req-catalog-anchorless",
			60000,
		);
		settingsValues.providers = originalProviders;
		const anchorlessIds = anchorlessEvent.catalog.models.map((m) => m.id);
		// p-anchor's model id comes from the degraded-discovery cache (the
		// seeded endpoint is unreachable); what matters is that the probe ran,
		// which proves the plugin root resolved without anchor or env.
		if (!anchorlessIds.some((id) => id.startsWith("p-anchor/"))) {
			fail(`anchorless catalog did not build; got: ${anchorlessIds.join(", ")}`);
		}
		if (!existsSync(join(anchorlessDataDir, "plugin-root.json"))) {
			fail("anchorless resolution did not self-heal the anchor file");
		}
		const anchorDoc = JSON.parse(readFileSync(join(anchorlessDataDir, "plugin-root.json"), "utf8"));
		if (anchorDoc.root !== pluginRoot) fail(`self-healed anchor points at ${anchorDoc.root}`);
		console.log("PASS: anchorless resolution via daemon registry, anchor self-healed");
	} finally {
		process.env.PASEO_HOME = prevHome;
		if (prevRoot !== undefined) process.env.AUTUMN_PLUGIN_ROOT = prevRoot;
	}
}

await connection.close();
server.close();
await new Promise((resolve) => setTimeout(resolve, 1500));
const orphanedPi = listPiChildren().filter((pid) => !piChildrenBaseline.includes(pid));
if (orphanedPi.length > 0) {
	fail(`orphaned pi children remain after close: ${orphanedPi.join(",")}`);
}
console.log("PASS: no orphaned pi children after every close");
if (readdirSync(extAgentDir).sort().join(",") !== externalSnapshot()) {
	fail(`external dir changed during run: ${readdirSync(extAgentDir).sort().join(",")}`);
}
if (readFileSync(join(extAgentDir, "auth.json"), "utf8") !== externalAuthBefore) {
	fail("external auth.json was modified during the run");
}
if (existsSync(join(extAgentDir, "models-store.json"))) {
	fail("pi wrote models-store.json into the external dir");
}
console.log("PASS: external pi dir untouched (no writes, no models-store.json)");
console.log(`INFO: mock LLM served ${llmCalls} completions`);
console.log("INTEGRATION TEST OK");
process.exit(0);
