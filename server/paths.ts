import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_ID = 'autumn-studio';

/**
 * Plugin-owned data root. The plugin subprocess inherits the daemon's
 * environment, so PASEO_HOME resolves to the same home the daemon writes to
 * (dev checkouts set it to <repo>/.dev/paseo-home; the packaged daemon uses
 * ~/.paseo). Nothing outside this tree is written; the user's external
 * `~/.pi/agent` is only read, and only when the reuse toggle is on.
 */
export function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), '.paseo');
}

export function pluginDataDir(): string {
  return join(paseoHome(), 'plugin-data', PLUGIN_ID);
}

/**
 * Shared agent dir for the catalog probe (generated auth.json/models.json,
 * empty mcp.json). Sessions get their own dir — see sessionAgentDir.
 */
export function agentDir(): string {
  return join(pluginDataDir(), 'agent-dir');
}

/**
 * Per-session agent dir holding that session's generated auth.json,
 * models.json, and mcp.json (pi 1.0.0 has no --mcp-config flag, so per-session
 * MCP servers must go through the agent dir). The dir lives on after close:
 * the pi session file it references is the persistence handle for resume.
 */
export function sessionAgentDir(sessionId: string): string {
  return join(pluginDataDir(), 'agent-dirs', sessionId);
}

export function sessionsDir(): string {
  return join(pluginDataDir(), 'sessions');
}

function anchorPath(): string {
  return join(pluginDataDir(), 'plugin-root.json');
}

function looksLikePluginRoot(dir: string): boolean {
  return existsSync(join(dir, 'paseo-plugin.json'));
}

function readAnchorRoot(): string | null {
  try {
    const anchor = JSON.parse(readFileSync(anchorPath(), 'utf8')) as {
      root?: unknown;
    };
    if (typeof anchor.root === 'string' && looksLikePluginRoot(anchor.root))
      return anchor.root;
  } catch {}
  return null;
}

/**
 * The daemon records directory-source installs with their on-disk path in
 * $PASEO_HOME/config.json (plugins.<id>.path). For an install whose manifest
 * build step predates the anchor (or a "reload", which recompiles without
 * running the build), this registry is the only plugin-visible record of
 * where the plugin lives — the child process gets no cwd or argv hint. The
 * shape is daemon-internal; anything unexpected degrades to null.
 */
function readRegistryRoot(): string | null {
  try {
    const config = JSON.parse(
      readFileSync(join(paseoHome(), 'config.json'), 'utf8'),
    ) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const entry = config.plugins?.[PLUGIN_ID];
    const dir = typeof entry?.path === 'string' ? entry.path : null;
    if (dir && looksLikePluginRoot(dir)) return dir;
  } catch {}
  return null;
}

/**
 * Caches a successful discovery so later resolutions skip the registry read.
 * Best effort — an unwritable data dir must not fail plugin-root resolution.
 */
function persistAnchor(root: string): void {
  try {
    mkdirSync(pluginDataDir(), { recursive: true });
    writeFileSync(anchorPath(), `${JSON.stringify({ root }, null, 1)}\n`);
  } catch {}
}

/**
 * Resolves the plugin's own directory. The evaluated server bundle has no
 * __dirname and the daemon's require does not resolve plugin node_modules;
 * the daemon knows the directory (it sends pluginDirectory in the child's
 * initialize message) but the SDK does not expose it. Resolution order:
 * explicit env override → anchor file (written by the manifest build step
 * and self-healed below) → the daemon's plugin registry in config.json →
 * known locations. Every successful non-env resolution persists the anchor.
 */
export function pluginRoot(): string {
  const override = process.env.AUTUMN_PLUGIN_ROOT;
  if (override && looksLikePluginRoot(override)) return override;

  const fromAnchor = readAnchorRoot();
  if (fromAnchor) return fromAnchor;

  const fromRegistry = readRegistryRoot();
  if (fromRegistry) {
    persistAnchor(fromRegistry);
    return fromRegistry;
  }

  const candidates = [
    process.cwd(),
    join(process.cwd(), PLUGIN_ID),
    join(process.cwd(), '..', PLUGIN_ID),
    join(paseoHome(), 'plugins', PLUGIN_ID),
  ];
  for (const candidate of candidates) {
    if (looksLikePluginRoot(candidate)) {
      persistAnchor(candidate);
      return candidate;
    }
  }
  throw new Error(
    'Could not locate the autumn-studio plugin directory (no plugin-root.json anchor, AUTUMN_PLUGIN_ROOT, daemon plugin registry, or known install location)',
  );
}

/**
 * Path to server/pi-runner.ts, which runs Pi in RPC mode as a standard
 * Node.js subprocess with native TypeScript type stripping, ESM resolution,
 * filesystem access, and WASM.
 */
export function runnerScriptPath(): string {
  if (
    process.env.AUTUMN_PI_RUNNER &&
    existsSync(process.env.AUTUMN_PI_RUNNER)
  ) {
    return process.env.AUTUMN_PI_RUNNER;
  }
  return join(pluginRoot(), 'server', 'pi-runner.ts');
}
