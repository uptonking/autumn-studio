import type { VendorAgentSession, VendorSessionEntry } from "./pi-sdk.cjs";
import type {
	ProviderEvent,
	ProviderToolCallDetail,
	ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";

/**
 * Maps pi's tool execution lifecycle into Paseo's ProviderToolCallDetail.
 * Tool argument shapes follow pi's built-in tools: bash{command}, read{path},
 * write{path,content}, edit{edits[]|oldText/newText}.
 */
/**
 * Pi tool results arrive as structured AgentToolResult objects
 * ({content: [{type:"text"|"image", ...}], ...}); flatten them to the text
 * the tool cards display. Strings pass through unchanged.
 */
function resultToText(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result;
	if (Array.isArray(result)) {
		const texts = result
			.map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : typeof b === "string" ? b : null))
			.filter((t): t is string => t !== null);
		if (texts.length > 0) return texts.join("\n");
	}
	if (typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
		const blocks = (result as { content: Array<{ type?: string; text?: string }> }).content;
		return blocks
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	}
	return JSON.stringify(result, null, 2);
}

function mapToolDetail(
	toolName: string,
	args: unknown,
	result?: unknown,
): ProviderToolCallDetail {
	const parsedArgs = (typeof args === "string" ? safeJsonParse(args) : (args ?? {})) as Record<string, unknown>;
	const outputText = resultToText(result);
	const filePath = typeof parsedArgs.path === "string" ? parsedArgs.path : "";

	switch (toolName) {
		case "bash":
		case "powershell":
			return {
				type: "shell",
				command: typeof parsedArgs.command === "string" ? parsedArgs.command : "",
				output: outputText,
			};
		case "read":
			return { type: "read", filePath, content: outputText };
		case "write":
			return { type: "write", filePath, content: typeof parsedArgs.content === "string" ? parsedArgs.content : outputText };
		case "edit": {
			const edits = Array.isArray(parsedArgs.edits) ? parsedArgs.edits : [];
			const first = edits[0] as { oldText?: unknown; newText?: unknown } | undefined;
			const oldString = typeof first?.oldText === "string" ? first.oldText : typeof parsedArgs.oldText === "string" ? parsedArgs.oldText : undefined;
			const newString = typeof first?.newText === "string" ? first.newText : typeof parsedArgs.newText === "string" ? parsedArgs.newText : undefined;
			return { type: "edit", filePath, oldString, newString };
		}
		case "grep":
		case "find":
			return {
				type: "search",
				query: typeof parsedArgs.pattern === "string" ? parsedArgs.pattern : typeof parsedArgs.query === "string" ? parsedArgs.query : "",
				toolName: toolName === "grep" ? "grep" : "glob",
				content: outputText,
			};
		default:
			return {
				type: "unknown",
				input: (parsedArgs ?? null) as unknown as any,
				output: (result ?? null) as unknown as any,
			};
	}
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { raw: text };
	}
}

/**
 * Subscribes to a pi AgentSession and forwards events as Paseo ProviderEvents.
 * Returns an unsubscribe cleanup function.
 */
export function mapPiEvents(
	sessionId: string,
	piSession: VendorAgentSession,
	emit: (event: ProviderEvent) => void,
	getTurnId: () => string | null,
): () => void {
	let messageCounter = 0;
	let activeAssistantId = "";
	let accumulatedAssistantText = "";
	let activeThinkingId = "";
	let accumulatedThinkingText = "";
	const toolArgsMap = new Map<string, { toolName: string; args: unknown }>();

	const startNewAssistantMessage = () => {
		messageCounter++;
		activeAssistantId = `assistant-${messageCounter}-${Date.now()}`;
		accumulatedAssistantText = "";
		activeThinkingId = `thinking-${messageCounter}-${Date.now()}`;
		accumulatedThinkingText = "";
	};

	return piSession.subscribe((event: { type: string; [key: string]: unknown }) => {
		switch (event.type) {
			case "turn_start": {
				startNewAssistantMessage();
				break;
			}

			case "message_update": {
				const ame = event.assistantMessageEvent as
					| { type: string; delta?: string }
					| undefined;
				if (!ame) break;

				if (ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
					if (!activeAssistantId) startNewAssistantMessage();
					accumulatedAssistantText += ame.delta;
					emit({
						type: "timeline.item",
						sessionId,
						item: { type: "assistant_message", id: activeAssistantId, text: accumulatedAssistantText },
					});
				} else if (ame.type === "thinking_delta" && typeof ame.delta === "string" && ame.delta) {
					if (!activeThinkingId) {
						activeThinkingId = `thinking-${messageCounter}-${Date.now()}`;
						accumulatedThinkingText = "";
					}
					accumulatedThinkingText += ame.delta;
					emit({
						type: "timeline.item",
						sessionId,
						item: { type: "reasoning", id: activeThinkingId, text: accumulatedThinkingText },
					});
				}
				break;
			}

			case "tool_execution_start": {
				// A tool call ends the current assistant text block; the next text
				// delta after execution belongs to a new message.
				activeAssistantId = "";
				accumulatedAssistantText = "";

				const callId = (event.toolCallId as string) ?? `call-${Date.now()}`;
				toolArgsMap.set(callId, { toolName: event.toolName as string, args: event.args });
				const detail = mapToolDetail(event.toolName as string, event.args);

				emit({
					type: "timeline.item",
					sessionId,
					item: {
						type: "tool_call",
						id: `tc-${callId}`,
						callId,
						name: (event.toolName as string) ?? "tool",
						status: "running",
						error: null,
						detail,
					},
				});
				break;
			}

			case "tool_execution_update": {
				const callId = (event.toolCallId as string) ?? `call-${Date.now()}`;
				const stored = toolArgsMap.get(callId);
				const detail = mapToolDetail(stored?.toolName ?? (event.toolName as string), stored?.args ?? event.args, event.partialResult);

				emit({
					type: "timeline.item",
					sessionId,
					item: {
						type: "tool_call",
						id: `tc-${callId}`,
						callId,
						name: stored?.toolName ?? ((event.toolName as string) ?? "tool"),
						status: "running",
						error: null,
						detail,
					},
				});
				break;
			}

			case "tool_execution_end": {
				const callId = (event.toolCallId as string) ?? `call-${Date.now()}`;
				const stored = toolArgsMap.get(callId);
				toolArgsMap.delete(callId);
				const toolName = stored?.toolName ?? ((event.toolName as string) ?? "tool");
				const detail = mapToolDetail(toolName, stored?.args ?? event.args, event.result);
				const isError = event.isError === true;

				const item: ProviderTimelineItem = isError
					? {
							type: "tool_call",
							id: `tc-${callId}`,
							callId,
							name: toolName,
							status: "failed",
							error: typeof event.result === "string" ? event.result : resultToText(event.result) || "Tool execution failed",
							detail,
						}
					: {
							type: "tool_call",
							id: `tc-${callId}`,
							callId,
							name: toolName,
							status: "completed",
							error: null,
							detail,
						};
				emit({ type: "timeline.item", sessionId, item });
				break;
			}

			case "turn_end": {
				// Per-turn usage lives on the completed assistant message; session
				// stats are cumulative and would double-count when shown per turn.
				// Tool-call rounds can end with an empty usage object — skip those
				// rather than emitting zero rows.
				const message = event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } } | undefined;
				const usage = message?.usage;
				if (usage && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0)) {
					emit({
						type: "session.usage",
						sessionId,
						turnId: getTurnId() ?? undefined,
						usage: {
							inputTokens: usage.input,
							outputTokens: usage.output,
							cachedInputTokens: usage.cacheRead,
							totalCostUsd: usage.cost?.total,
						},
					});
				}
				break;
			}

			case "auto_retry_start": {
				emit({
					type: "timeline.item",
					sessionId,
					item: {
						type: "notification",
						id: `retry-${Date.now()}`,
						level: "info",
						message: `Request failed, retrying (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? ""}`.trim(),
					},
				});
				break;
			}

			case "compaction_start": {
				emit({
					type: "timeline.item",
					sessionId,
					item: {
						type: "compaction",
						id: `compaction-start-${Date.now()}`,
						status: "loading",
						trigger: event.reason === "manual" ? "manual" : "auto",
					},
				});
				break;
			}

			case "compaction_end": {
				emit({
					type: "timeline.item",
					sessionId,
					item: {
						type: "compaction",
						id: `compaction-end-${Date.now()}`,
						status: "completed",
					},
				});
				break;
			}
		}
	});
}

type ReplayItem = ProviderTimelineItem;

/**
 * Maps stored pi session entries into Paseo timeline items for
 * `session.open` with `history: "replay"`. Tool calls are emitted once, at
 * their result, so cards render completed with output attached.
 */
export function mapReplayEntries(entries: readonly VendorSessionEntry[]): ReplayItem[] {
	const items: ReplayItem[] = [];
	const pendingCalls = new Map<string, { id: string; name: string; args: unknown }>();
	let counter = 0;

	const nextId = (prefix: string) => `${prefix}-replay-${++counter}`;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as ReplayMessage;
		const parts = Array.isArray(message.content) ? message.content : [];
		if (message.role === "user") {
			const text = typeof message.content === "string"
				? message.content
				: parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
			if (text) items.push({ type: "user_message", id: nextId("user"), text });
			continue;
		}
		if (message.role === "assistant") {
			for (const part of parts) {
				if (part.type === "text" && part.text) {
					items.push({ type: "assistant_message", id: nextId("assistant"), text: part.text });
				} else if (part.type === "thinking" && part.thinking) {
					items.push({ type: "reasoning", id: nextId("thinking"), text: part.thinking });
				} else if (part.type === "toolCall" && part.id && part.name) {
					pendingCalls.set(part.id, { id: part.id, name: part.name, args: part.arguments });
				}
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			const call = pendingCalls.get(message.toolCallId);
			pendingCalls.delete(message.toolCallId);
			const name = call?.name ?? message.toolName ?? "tool";
			const outputText = typeof message.content === "string"
				? message.content
				: resultToText(message.content);
			const detail = mapToolDetail(name, call?.args, outputText);
			const item: ReplayItem = message.isError
				? {
						type: "tool_call",
						id: `tc-${message.toolCallId}`,
						callId: message.toolCallId,
						name,
						status: "failed",
						error: "Tool execution failed",
						detail,
					}
				: {
						type: "tool_call",
						id: `tc-${message.toolCallId}`,
						callId: message.toolCallId,
						name,
						status: "completed",
						error: null,
						detail,
					};
			items.push(item);
		}
	}

	return items;
}

type ReplayContent = {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
};

interface ReplayMessage {
	role: string;
	content?: string | ReplayContent[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}
