#!/usr/bin/env node
/**
 * Build server/pi-sdk.cjs — a self-contained CJS bundle of the pi coding-agent
 * SDK surface (vendor-entry.ts).
 *
 * Why this exists: the Paseo plugin compiler bundles `index.server.ts` with
 * esbuild (format=cjs) and the daemon evaluates the bundle via globalThis.eval
 * inside `(function(require){...})` — no `__filename`, no `__dirname`, no real
 * `import.meta`. Bundling pi through that pipeline breaks on pi's module-scope
 * `__filename` use, and pi's package "." entry drags the interactive TUI into
 * the graph. Building our own bundle here lets us:
 *   - ship only the core SDK (no TUI, no CLI),
 *   - shim `__filename`/`__dirname` (banner below) so module-scope references
 *     evaluate safely inside the eval'd wrapper,
 *   - define PI_BUNDLED_NODE so pi uses its embedded-module code paths,
 *   - keep node builtins as the only externals, so the Paseo compiler's
 *     re-bundle of server/pi-sdk.cjs resolves everything from within.
 *
 * `PI_PACKAGE_DIR`-derived paths (built-in extensions, themes) intentionally
 * resolve to nowhere: built-in extension loads fail per-extension and are
 * collected as non-fatal diagnostics by the resource loader.
 */
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "..", "server", "pi-sdk.cjs");

// The eval'd CJS bundle has no real import.meta (esbuild's CJS output turns
// import.meta into an empty object, so import.meta.url reads undefined and
// pi's module-scope `import.meta.url.includes(...)` checks crash). Rewrite
// every import.meta member in input sources to constants the banner defines.
// The fake URL is a syntactically valid file URL: path/URL helpers parse it,
// and reads against the nonexistent path fail like any missing asset.
const VENDOR_URL = "file:///autumn-studio-server/pi-sdk.cjs";
const importMetaPlugin = {
	name: "autumn-import-meta-shim",
	setup(build) {
		build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
			const { readFileSync } = await import("node:fs");
			const contents = readFileSync(args.path, "utf8");
			if (!contents.includes("import.meta")) return undefined;
			const rewritten = contents
				.replaceAll("import.meta.url", JSON.stringify(VENDOR_URL))
				.replaceAll("import.meta.dirname", JSON.stringify(dirname(VENDOR_URL)))
				.replaceAll("import.meta.filename", JSON.stringify("pi-sdk.cjs"));
			const loader = args.path.endsWith(".ts") ? "ts" : args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".mjs") ? "js" : "js";
			return { contents: rewritten, loader };
		});
	},
};

const result = await build({
	entryPoints: [join(root, "..", "vendor-entry.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node20",
	// WASM-backed packages: bundling them would inline a module-scope
	// fs.readFileSync of an adjacent .wasm that cannot exist in the eval'd
	// bundle. Kept external so their lazy loaders fail inside the try/catch
	// pi already wraps them in (image resize degrades, codemode tool errors).
	external: ["@silvia-odwyer/photon-node", "quickjs-wasi"],
	// Eval'd once at plugin load — minify keeps the (large) bundle manageable.
	minify: true,
	sourcemap: false,
	keepNames: true,
	banner: {
		js: [
			// The Paseo daemon evaluates this bundle via globalThis.eval inside a
			// factory that supplies only `require`. Define the CJS globals esbuild
			// emits references to.
			`var __filename = ${JSON.stringify(VENDOR_URL.slice("file://".length))};`,
			`var __dirname = ${JSON.stringify("/autumn-studio-vendor")};`,
		].join("\n"),
	},
	define: {
		PI_BUNDLED_NODE: "true",
	},
	plugins: [importMetaPlugin],
	logLevel: "warning",
	write: false,
	metafile: true,
});

const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, result.outputFiles[0].text);

const kb = Math.round(statSyncFake());
function statSyncFake() {
	return Buffer.byteLength(result.outputFiles[0].text) / 1024;
}
console.log(`server/pi-sdk.cjs written (${kb} KB)`);
