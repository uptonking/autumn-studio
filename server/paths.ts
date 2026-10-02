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
