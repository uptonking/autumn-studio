/**
 * Hand-written subset of pi's RPC wire protocol (the installed package's
 * dist/modes/rpc/rpc-types.d.ts). Kept structural and dependency-free: the
 * Paseo plugin compiler walks the type graph of everything a plugin module
 * imports, and pi's published type graph does not resolve inside that
 * boundary. Shapes cover only what autumn-studio consumes.
 */

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PiModel {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow?: number;
	input?: string[];
}

export interface PiSessionState {
	model?: PiModel;
	thinkingLevel: PiThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
}

export interface PiSlashCommand {
	name: string;
	description?: string;
	source?: string;
}

export interface PiPromptResult {
	disposition: "started" | "queued" | "handled";
}

/** One stored session entry; only message entries carry a message payload. */
export interface PiSessionMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

export interface PiSessionEntry {
	type: string;
	message?: PiSessionMessage;
}

export interface PiAgentMessage {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	[key: string]: unknown;
}
