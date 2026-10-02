#!/usr/bin/env node
/**
 * End-to-end plugin compile test: runs the REAL Paseo plugin compiler from
 * packages/server against this plugin's entries, then evaluates the produced
 * server bundle through the REAL bundle evaluator path (globalThis.eval inside
 * a (require) factory), proving the vendored pi SDK survives the full
 * daemon-side pipeline — compiler boundary checks included.
 *
 * Run from the paseo repo root: node ../autumn-studio/scripts/test-compile.mjs <paseo-repo>
 */
import { pathToFileURL } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import process from "node:process";

const pluginRoot = path.resolve(import.meta.dirname, "..");
// Defaults to the sibling paseo checkout, like the other scripts.
const paseoRoot = path.resolve(process.argv[2] ?? path.join(pluginRoot, "..", "paseo"));
const require2 = createRequire(import.meta.url);
const compiler = await import(
	pathToFileURL(path.join(paseoRoot, "packages/server/dist/server/server/plugins/compiler.js")).href
);

console.log("compiling plugin with the real Paseo compiler…");
const { serverBundle, clientBundle } = await compiler.compilePlugin({
	server: path.join(pluginRoot, "index.server.ts"),
	client: path.join(pluginRoot, "index.client.tsx"),
});
console.log(
	`compiled: server=${serverBundle ? Math.round(serverBundle.length / 1024) + "KB" : "none"}, client=${clientBundle ? Math.round(clientBundle.length / 1024) + "KB" : "none"}`,
);

// Evaluate the server bundle exactly like the daemon's bundle evaluator does.
const nodeRequire = createRequire(import.meta.url);
function runtimeRequire(name) {
	// Host SDK modules are served from the built plugin package, like the daemon.
	if (name === "@getpaseo/plugin") return require2(path.join(paseoRoot, "packages/plugin/dist/index.js"));
	if (name === "@getpaseo/plugin/server") return require2(path.join(paseoRoot, "packages/plugin/dist/server/index.js"));
	if (name === "@getpaseo/plugin/server/provider") return require2(path.join(paseoRoot, "packages/plugin/dist/server/provider.js"));
	if (name === "zod") return require2("zod");
	if (isBuiltin(name)) return nodeRequire(name);
	throw new Error(`bundle leaked a runtime dependency: ${name}`);
}

const evaluate = globalThis.eval;
// compilePlugin output is already wrapped in the daemon's `(function(require){...})`
// factory — evaluate it directly, exactly like bundle-evaluator.ts does.
const exportsObject = evaluate(serverBundle)(runtimeRequire);
const setup = exportsObject !== null && typeof exportsObject === "object" ? exportsObject.default : exportsObject;
if (typeof setup !== "function") {
	console.error("FAIL: server bundle did not produce a setup function");
	process.exit(1);
}

const contributions = setup({
	registerProvider(provider) {
		console.log(`PASS: provider registered: id=${provider.id} label=${provider.label} command=${provider.command ? "set" : "none (embedded)"}`);
		if (!provider.status || !provider.connect) {
			console.error("FAIL: provider missing status/connect");
			process.exit(1);
		}
	},
	registerSettings() {
		console.log("PASS: settings registered");
	},
	handle(contract, handler) {
		console.log(`PASS: rpc registered: ${contract.name}`);
	},
});
console.log("PASS: server bundle evaluated in daemon-style context and contributed");
console.log("COMPILE TEST OK");
