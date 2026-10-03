import type {
	ProviderConnection,
	ProviderEvent,
	ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { requireProviderCapabilities } from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { settings } from "../shared/settings.js";
import type { PromptImage } from "./session.js";
import { buildProviderCatalog } from "./catalog.js";
import { PiRpcSession } from "./session.js";

type SettingsHandle = PluginSettings<typeof settings.schema>;

export function createAutumnConnection(
	capabilities: readonly string[],
	settingsHandle: SettingsHandle,
): ProviderConnection {
	const listeners = new Set<(event: ProviderEvent) => void>();
	const sessions = new Map<string, PiRpcSession>();
	let closed = false;

	const emit = (event: ProviderEvent) => {
		if (closed) return;
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("autumn-studio: provider listener error", error);
			}
		}
	};

	return {
		version: 1,
		capabilities,

		async send(input: ProviderInput) {
			if (closed) throw new Error("Connection closed");
			validateAdmission(input, { sessions, capabilities });
			// Dispatch asynchronously so send() resolves immediately, matching
			// the provider-direct reference implementation.
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
				await session.dispose();
			}
			sessions.clear();
			listeners.clear();
		},
	};
}

interface ConnectionState {
	sessions: Map<string, PiRpcSession>;
	emit(event: ProviderEvent): void;
	settingsHandle: SettingsHandle;
	capabilities: readonly string[];
}

/** Unknown sessions and unsupported capability requests fail the send, like the reference provider. */
function validateAdmission(
	input: ProviderInput,
	state: Pick<ConnectionState, "sessions" | "capabilities">,
): void {
	if (input.type === "session.open") {
		if (state.sessions.has(input.sessionId)) {
			throw new Error(`Session already exists: ${input.sessionId}`);
		}
		requireProviderCapabilities(state.capabilities, input);
		return;
	}
	if (!("sessionId" in input)) {
		requireProviderCapabilities(state.capabilities, input);
		return;
	}
	if (input.type === "session.prompt" || input.type === "session.permission") {
		if (!state.sessions.has(input.sessionId)) {
			throw new Error(`Unknown session: ${input.sessionId}`);
		}
	}
	requireProviderCapabilities(state.capabilities, input);
}

function errorOf(err: unknown): { message: string } {
	return { message: err instanceof Error ? err.message : String(err) };
}

async function dispatch(
	input: ProviderInput,
	state: ConnectionState,
): Promise<void> {
	switch (input.type) {
		case "catalog": {
			try {
				const catalog = await buildProviderCatalog(state.settingsHandle);
				state.emit({ type: "catalog", requestId: input.requestId, catalog });
			} catch (err) {
				// A failed catalog build must surface as request.failed, not as an
				// unhandled rejection in the dispatch microtask.
				state.emit({ type: "request.failed", requestId: input.requestId, error: errorOf(err) });
			}
			return;
		}

		case "session.open": {
			try {
				const session = await PiRpcSession.create(
					input.sessionId,
					input.config,
					input.persistence,
					state.settingsHandle,
					state.emit,
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

				// Replay the stored conversation when the daemon asks for it
				// (restored agents must not open with an empty timeline).
				if (input.history === "replay") {
					for (const event of await session.replayHistory()) {
						state.emit(event);
					}
				}

				state.emit({
					type: "session.config",
					sessionId: input.sessionId,
					config: session.getConfigState(),
				});

				// Native pi slash commands (skills, prompt commands) surface for
				// the composer; invocation flows through the normal prompt path.
				const commands = await session.getCommands();
				if (commands.length > 0) {
					state.emit({ type: "session.commands", sessionId: input.sessionId, commands });
				}

				state.emit({
					type: "session.ready",
					requestId: input.requestId,
					sessionId: input.sessionId,
				});
			} catch (err) {
				state.emit({
					type: "session.runtime_failed",
					sessionId: input.sessionId,
					error: errorOf(err),
				});
				state.emit({ type: "request.failed", requestId: input.requestId, error: errorOf(err) });
			}
			return;
		}

		case "session.prompt": {
			const session = state.sessions.get(input.sessionId);
			if (!session) return;

			let text = "";
			const images: PromptImage[] = [];
			if (input.prompt.input.type === "message") {
				for (const part of input.prompt.input.content) {
					if (part.type === "text") {
						text = text ? `${text}\n${part.text}` : part.text;
					} else if (part.type === "image") {
						images.push({ type: "image", data: part.data, mimeType: part.mimeType });
					}
				}
			} else if (input.prompt.input.type === "command") {
				// pi handles slash prompts natively in RPC mode (the commands
				// surfaced via session.commands); send the text verbatim.
				text = `/${input.prompt.input.name} ${input.prompt.input.arguments}`.trim();
			}

			// The session emits the user_message item itself, gated on prompt
			// acceptance, then drives the turn.
			await session.prompt(
				text,
				images,
				input.prompt.clientMessageId,
				input.prompt.delivery,
				state.emit,
			);

			state.emit({
				type: "session.persistence",
				sessionId: input.sessionId,
				persistence: session.getPersistence(),
			});
			return;
		}

		case "session.interrupt": {
			const session = state.sessions.get(input.sessionId);
			if (session) {
				try {
					await session.abort();
				} catch (err) {
					console.error("autumn-studio: interrupt failed", err);
				}
			}
			state.emit({ type: "request.completed", requestId: input.requestId });
			return;
		}

		case "session.configure": {
			const session = state.sessions.get(input.sessionId);
			if (session) {
				try {
					const warning = await session.configure(input.changes);
					if (warning) {
						state.emit({
							type: "session.notice",
							sessionId: input.sessionId,
							notice: { id: `configure-${Date.now()}`, severity: "warning", title: warning },
						});
					}
				} catch (err) {
					// configure() is guarded internally; this is belt-and-braces so
					// dispatch never rejects.
					console.error("autumn-studio: configure failed", err);
				}
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
				state.sessions.delete(input.sessionId);
				await session.dispose();
			}
			state.emit({ type: "session.closed", sessionId: input.sessionId });
			state.emit({ type: "request.completed", requestId: input.requestId });
			return;
		}
	}
}
