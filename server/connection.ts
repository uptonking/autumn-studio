import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { settings } from "../shared/settings.js";
import { buildCatalog } from "./catalog.js";
import { EmbeddedSession } from "./session.js";

type SettingsHandle = PluginSettings<typeof settings.schema>;

export function createAutumnConnection(
  capabilities: readonly string[],
  settingsHandle: SettingsHandle,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, EmbeddedSession>();
  let closed = false;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Provider listener error:", err);
      }
    }
  };

  return {
    version: 1,
    capabilities,

    async send(input: ProviderInput) {
      if (closed) throw new Error("Connection closed");
      queueMicrotask(() => {
        if (!closed) void dispatch(input, { sessions, emit, settingsHandle, capabilities });
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) {
        session.dispose();
      }
      sessions.clear();
      listeners.clear();
    },
  };
}

interface ConnectionState {
  sessions: Map<string, EmbeddedSession>;
  emit(event: ProviderEvent): void;
  settingsHandle: SettingsHandle;
  capabilities: readonly string[];
}

async function dispatch(
  input: ProviderInput,
  state: ConnectionState,
): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const catalog = await buildCatalog(state.settingsHandle);
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog,
      });
      return;
    }

    case "session.open": {
      try {
        const session = await EmbeddedSession.create(
          input.sessionId,
          input.config,
          state.settingsHandle,
          state.emit,
          input.persistence,
        );
        state.sessions.set(input.sessionId, session);

        state.emit({
          type: "session.opened",
          requestId: input.requestId,
          sessionId: input.sessionId,
          capabilities: [...state.capabilities],
          restoration: "core",
          persistence: session.getPersistence(),
          cwd: input.config.cwd,
        });
        state.emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: session.getConfigState(),
        });
        state.emit({
          type: "session.ready",
          requestId: input.requestId,
          sessionId: input.sessionId,
        });
      } catch (err: any) {
        state.emit({
          type: "session.runtime_failed",
          sessionId: input.sessionId,
          error: { message: err?.message || String(err) },
        });
        state.emit({
          type: "request.failed",
          requestId: input.requestId,
          error: { message: err?.message || String(err) },
        });
      }
      return;
    }

    case "session.prompt": {
      const session = state.sessions.get(input.sessionId);
      if (!session) {
        state.emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: {
            type: "failed",
            error: { message: `Session not found: ${input.sessionId}` },
          },
        });
        return;
      }

      let text = "";
      if (input.prompt.input.type === "message") {
        text = input.prompt.input.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      } else if (input.prompt.input.type === "command") {
        text = `/${input.prompt.input.name} ${input.prompt.input.arguments}`;
      }

      // Emit user message timeline item
      state.emit({
        type: "timeline.item",
        sessionId: input.sessionId,
        item: {
          type: "user_message",
          id: `user-${Date.now()}`,
          text,
          clientMessageId: input.prompt.clientMessageId,
        },
      });

      await session.prompt(
        input.sessionId,
        text,
        input.prompt.clientMessageId,
        input.prompt.delivery,
        state.emit,
      );

      // Persist session state after turn completes
      state.emit({
        type: "session.persistence",
        sessionId: input.sessionId,
        persistence: session.getPersistence(),
      });
      return;
    }

    case "session.interrupt": {
      const session = state.sessions.get(input.sessionId);
      if (session) await session.abort();
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }

    case "session.configure": {
      const session = state.sessions.get(input.sessionId);
      if (session) {
        await session.configure(input.changes);
        state.emit({
          type: "session.config",
          sessionId: input.sessionId,
          config: session.getConfigState(),
        });
      }
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }

    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      if (session) {
        session.dispose();
        state.sessions.delete(input.sessionId);
      }
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
  }
}
