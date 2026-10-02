import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ProviderEvent,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

/**
 * Maps Pi's tool execution start/update/end into Paseo's ProviderToolCallDetail.
 */
function mapToolDetail(
  toolName: string,
  args: any,
  result?: any,
): ProviderToolCallDetail {
  const parsedArgs = typeof args === "string" ? safeJsonParse(args) : args ?? {};
  const outputText = typeof result === "string" ? result : result ? JSON.stringify(result, null, 2) : "";

  switch (toolName) {
    case "bash":
      return {
        type: "shell",
        command: typeof parsedArgs.command === "string" ? parsedArgs.command : "",
        output: outputText,
      };
    case "read":
      return {
        type: "read",
        filePath: typeof parsedArgs.path === "string" ? parsedArgs.path : (parsedArgs.filePath ?? ""),
        content: outputText,
      };
    case "edit":
      return {
        type: "edit",
        filePath: typeof parsedArgs.path === "string" ? parsedArgs.path : (parsedArgs.filePath ?? ""),
        oldString: parsedArgs.oldText,
        newString: parsedArgs.newText,
      };
    case "write":
      return {
        type: "write",
        filePath: typeof parsedArgs.path === "string" ? parsedArgs.path : (parsedArgs.filePath ?? ""),
        content: parsedArgs.content ?? outputText,
      };
    default:
      return {
        type: "unknown",
        input: parsedArgs,
        output: result ?? null,
      };
  }
}

function safeJsonParse(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

/**
 * Subscribes to a Pi AgentSession and forwards events as Paseo ProviderEvents.
 * Returns an unsubscribe cleanup function.
 */
export function mapPiEvents(
  sessionId: string,
  piSession: AgentSession,
  emit: (event: ProviderEvent) => void,
  getTurnId: () => string | null,
): () => void {
  let messageCounter = 0;
  let activeAssistantId = "";
  let accumulatedAssistantText = "";
  let activeThinkingId = "";
  let accumulatedThinkingText = "";
  const toolArgsMap = new Map<string, any>();

  const startNewAssistantMessage = () => {
    messageCounter++;
    activeAssistantId = `assistant-${messageCounter}-${Date.now()}`;
    accumulatedAssistantText = "";
    activeThinkingId = `thinking-${messageCounter}-${Date.now()}`;
    accumulatedThinkingText = "";
  };

  return piSession.subscribe((event: any) => {
    switch (event.type) {
      case "turn_start": {
        startNewAssistantMessage();
        break;
      }

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (!ame) break;

        if (ame.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
          if (!activeAssistantId) {
            startNewAssistantMessage();
          }
          accumulatedAssistantText += ame.delta;
          emit({
            type: "timeline.item",
            sessionId,
            item: {
              type: "assistant_message",
              id: activeAssistantId,
              text: accumulatedAssistantText,
            },
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
            item: {
              type: "reasoning",
              id: activeThinkingId,
              text: accumulatedThinkingText,
            },
          });
        }

        // Report usage updates if present
        if (event.usage) {
          const turnId = getTurnId();
          emit({
            type: "session.usage",
            sessionId,
            turnId: turnId ?? undefined,
            usage: {
              inputTokens: event.usage.inputTokens ?? event.usage.promptTokens,
              outputTokens: event.usage.outputTokens ?? event.usage.completionTokens,
              cachedInputTokens: event.usage.cachedTokens ?? event.usage.cacheReadInputTokens,
              totalCostUsd: event.usage.totalCostUsd ?? event.usage.cost,
            },
          });
        }
        break;
      }

      case "tool_execution_start": {
        // A tool call begins: reset assistant text accumulator so any subsequent
        // assistant response after tool execution starts in a new message block
        activeAssistantId = "";
        accumulatedAssistantText = "";

        const callId = event.toolCallId ?? `call-${Date.now()}`;
        toolArgsMap.set(callId, event.args);
        const detail = mapToolDetail(event.toolName, event.args);

        emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "tool_call",
            id: `tc-${callId}`,
            callId,
            name: event.toolName ?? "tool",
            status: "running",
            error: null,
            detail,
          },
        });
        break;
      }

      case "tool_execution_update": {
        const callId = event.toolCallId ?? `call-${Date.now()}`;
        const storedArgs = toolArgsMap.get(callId) ?? event.args;
        const detail = mapToolDetail(event.toolName, storedArgs, event.partialResult);

        emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "tool_call",
            id: `tc-${callId}`,
            callId,
            name: event.toolName ?? "tool",
            status: "running",
            error: null,
            detail,
          },
        });
        break;
      }

      case "tool_execution_end": {
        const callId = event.toolCallId ?? `call-${Date.now()}`;
        const storedArgs = toolArgsMap.get(callId) ?? event.args;
        toolArgsMap.delete(callId);
        const detail = mapToolDetail(event.toolName, storedArgs, event.result);

        if (event.isError) {
          emit({
            type: "timeline.item",
            sessionId,
            item: {
              type: "tool_call",
              id: `tc-${callId}`,
              callId,
              name: event.toolName ?? "tool",
              status: "failed",
              error: typeof event.result === "string" ? event.result : "Tool execution failed",
              detail,
            },
          });
        } else {
          emit({
            type: "timeline.item",
            sessionId,
            item: {
              type: "tool_call",
              id: `tc-${callId}`,
              callId,
              name: event.toolName ?? "tool",
              status: "completed",
              error: null,
              detail,
            },
          });
        }
        break;
      }

      case "turn_end": {
        // Turn ended: if stats are available, emit session usage
        try {
          const stats = piSession.getSessionStats?.();
          if (stats) {
            const turnId = getTurnId();
            emit({
              type: "session.usage",
              sessionId,
              turnId: turnId ?? undefined,
              usage: {
                inputTokens: stats.inputTokens,
                outputTokens: stats.outputTokens,
                cachedInputTokens: stats.cachedInputTokens,
                totalCostUsd: stats.totalCostUsd,
              },
            });
          }
        } catch {
          // stats not supported or failed, ignore
        }
        break;
      }

      case "compaction_start": {
        emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "compaction",
            id: `compaction-${Date.now()}`,
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
            id: `compaction-${Date.now()}`,
            status: "completed",
          },
        });
        break;
      }
    }
  });
}
