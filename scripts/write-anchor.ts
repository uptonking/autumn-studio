#!/usr/bin/env node
/**
 * Manifest build step (see paseo-plugin.json). Build commands run with cwd =
 * the plugin directory, so this records where the plugin lives. The evaluated
 * server bundle has no __dirname and the daemon's require cannot resolve the
 * plugin's node_modules, so server/paths.ts reads this anchor at runtime to
 * find server/pi-runner.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const paseoHome = process.env.PASEO_HOME ?? join(homedir(), '.paseo');
const dir = join(paseoHome, 'plugin-data', 'autumn-studio');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'plugin-root.json'),
  `${JSON.stringify({ root: process.cwd() }, null, 1)}\n`,
);
console.log(`autumn-studio: anchor written for ${process.cwd()}`);
