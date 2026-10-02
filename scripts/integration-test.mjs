#!/usr/bin/env node
/**
 * Provider-level integration test.
 *
 * Compiles the plugin with the REAL Paseo plugin compiler, evaluates the
 * bundle in the daemon-style eval context, and drives the contributed
 * provider end-to-end against a mock OpenAI-compatible LLM server:
 *
 *   status → catalog (with /v1/models discovery) → session.open →
 *   prompt 1: bash tool executed for real, streamed text answer, usage,
 *             persistence to a pi session file →
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
import { pathToFileURL } from "node:url";
import { mkdtempSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const root = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(root);
const paseoRoot = resolve(process.argv[2] ?? join(pluginRoot, "..", "paseo"));

// Isolated data dirs for the whole test.
process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "autumn-integration-"));
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
				// Turn 1: ask for the bash tool, then stop for its result.
				sse(res, [
					chunk(id, 0, { role: "assistant", content: "" }),
					chunk(id, 0, { tool_calls: [{ ...call(1), function: { name: "bash", arguments: "" } }] }),
					chunk(id, 0, { tool_calls: [{ index: 0, function: { arguments: '{"command":"echo integration-tool-ok"}' } }] }),
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
	defaultThinkingLevel: "medium",
	customInstructions: "",
	providers: [
		{
			id: "p1",
			name: "Mock LLM",
			type: "custom",
			apiKey: "mock-key",
			baseUrl: `http://127.0.0.1:${mockPort}/v1`,
			reasoning: true,
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
setup({
	registerProvider(p) {
		provider = p;
	},
	registerSettings() {
		return settingsHandle;
	},
	handle() {},
});

function fail(message) {
	console.error(`FAIL: ${message}`);
	server.close();
	process.exit(1);
}

if (!provider) fail("provider was not registered");
console.log(`PASS: provider registered: id=${provider.id} (command: ${provider.command ? "set" : "none, embedded"})`);

// ---------------------------------------------------------------------------
// Drive the provider
// ---------------------------------------------------------------------------

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
			env: {},
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

// 4. Prompt 1: bash tool executes for real, then streamed text with usage.
prompt("s1", "msg-1", "Run echo integration-tool-ok, then tell me the output.");
await waitFor("turn started", (e) => e.type === "session.turn" && e.state === "started");
await waitFor("bash tool completed", (e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed" && e.item.name === "bash");
const bashItem = events.find((e) => e.type === "timeline.item" && e.item.type === "tool_call" && e.item.status === "completed" && e.item.name === "bash");
const bashOutput = bashItem.item.detail.type === "shell" ? bashItem.item.detail.output ?? "" : "";
if (!bashOutput.includes("integration-tool-ok")) fail(`bash tool output missing marker: ${bashOutput.slice(0, 200)}`);
console.log(`PASS: bash tool executed; output: ${bashOutput.trim().slice(0, 60)}`);

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

await connection.close();
server.close();
console.log(`INFO: mock LLM served ${llmCalls} completions`);
console.log("INTEGRATION TEST OK");
process.exit(0);
