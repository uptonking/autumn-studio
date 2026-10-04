#!/usr/bin/env node
/**
 * `prepare` lifecycle entry point: installs lefthook's git hooks for this
 * plugin's own working copy.
 *
 * Paseo runs a plugin's manifest build steps inside a directory it manages
 * (git/npm sources are cloned or unpacked; `runPluginBuild` in
 * packages/server/src/server/plugins/preparation.ts) and treats any non-zero
 * exit code as a failed install. It also leaves a cloned `.git` intact, so
 * "there is a .git here" alone does not mean this is a developer checkout.
 * Every path that cannot install hooks therefore exits 0 quietly: a missing
 * hook is a non-event, a failed plugin install is not.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const pluginRoot = path.resolve(import.meta.dirname, '..');

function skip(reason: string): never {
  console.log(`install-git-hooks: skipped (${reason})`);
  process.exit(0);
}

// Lefthook's own escape hatch, plus the standard "no scripts in CI" case.
if (process.env.LEFTHOOK === '0') skip('LEFTHOOK=0');

// Only the plugin's own checkout owns hooks here. A `.git` file means a linked
// worktree or submodule, where the hooks live outside this directory.
const gitEntry = path.join(pluginRoot, '.git');
if (!existsSync(gitEntry) || !statSync(gitEntry).isDirectory()) {
  skip("not the plugin's own git checkout");
}

const lefthook = ['lefthook', 'lefthook.cmd']
  .map((name) => path.join(pluginRoot, 'node_modules', '.bin', name))
  .find((candidate) => existsSync(candidate));
if (!lefthook) skip('lefthook is not installed (devDependencies omitted?)');

const result = spawnSync(lefthook, ['install', '--force'], {
  cwd: pluginRoot,
  stdio: 'inherit',
  // Windows resolves the .cmd shim only through a shell.
  shell: process.platform === 'win32',
});
if (result.error || result.status !== 0) {
  console.warn(
    `install-git-hooks: lefthook install failed (${result.error?.message ?? `exit ${result.status}`}); continuing without hooks`,
  );
}
process.exit(0);
