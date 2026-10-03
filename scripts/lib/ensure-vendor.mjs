/**
 * Ensure server/pi-sdk.cjs exists, building it when absent.
 *
 * The bundle is a generated artifact (gitignored; built by the manifest
 * `build` step at install time), so a fresh clone or a clean checkout does
 * not have it. Test scripts call this before reading the bundle.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "..");
const bundlePath = join(pluginRoot, "server", "pi-sdk.cjs");

export function ensureVendorBundle() {
	if (existsSync(bundlePath)) return;
	console.log("server/pi-sdk.cjs missing — building vendor bundle…");
	const result = spawnSync("node", [join(pluginRoot, "scripts", "build-vendor.mjs")], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		console.error("vendor bundle build failed");
		process.exit(1);
	}
}
