/**
 * Types for the vendored SDK bundle (server/pi-sdk.cjs).
 *
 * Deliberately self-contained: the Paseo plugin compiler's boundary checker
 * walks the type-declaration graph of every import, and pi's published type
 * graph does not resolve outside its own tree (broken relative links inside
 * nested dependencies). So these are minimal structural types with no
 * external imports — the bundle itself carries the real implementations.
 */

export interface VendorToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface VendorToolUpdate {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details?: unknown;
}

export interface VendorToolDefinition {
	name: string;
	label: string;
	description: string;
	/** JSON Schema of the tool parameters (TypeBox-compatible). */
	parameters: unknown;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: VendorToolUpdate) => void) | undefined,
		ctx: unknown,
	): Promise<VendorToolResult>;
}

export interface VendorModelInfo {
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface VendorModelRuntime {
	getModel(providerId: string, modelId: string): unknown;
	getAvailable(): Promise<readonly VendorModelInfo[]>;
	registerProvider(providerId: string, config: unknown): void;
	setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

export interface VendorSessionEntry {
	type: string;
	message?: unknown;
	[key: string]: unknown;
}

export interface VendorSessionManager {
	getEntries(): VendorSessionEntry[];
	getSessionFile(): string | undefined;
}

export interface VendorAgentSessionEvent {
	type: string;
	[key: string]: unknown;
}

export interface VendorAgentSession {
	subscribe(listener: (event: VendorAgentSessionEvent) => void): () => void;
	prompt(
		text: string,
		options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> },
	): Promise<void>;
	steer(
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): Promise<void>;
	abort(): Promise<void>;
	setModel(model: unknown): Promise<void>;
	setThinkingLevel(level: string): void;
	dispose(): void;
	readonly sessionManager: VendorSessionManager;
}

export interface VendorResourceLoader {
	reload(options?: unknown): Promise<void>;
}

export declare class DefaultResourceLoader {
	constructor(options: {
		cwd: string;
		agentDir: string;
		noExtensions?: boolean;
		appendSystemPromptOverride?: (base: string[]) => string[];
	});
	reload(options?: unknown): Promise<void>;
}

export declare class ModelRuntime {
	static create(options: {
		modelsPath?: string | null;
		allowModelNetwork?: boolean;
		refreshOnCreate?: boolean;
	}): Promise<ModelRuntime>;
	getModel(providerId: string, modelId: string): { reasoning?: boolean } | undefined;
	getAvailable(): Promise<readonly VendorModelInfo[]>;
	registerProvider(providerId: string, config: unknown): void;
	setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

export declare class SessionManager {
	static create(cwd: string, sessionDir?: string): SessionManager;
	static inMemory(cwd?: string): SessionManager;
	setSessionFile(sessionFile: string): void;
}

export declare class McpClient {
	constructor(options: { name: string; version: string });
	connect(transport: unknown): Promise<unknown>;
	listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
	callTool(name: string, args?: Record<string, unknown>): Promise<{
		content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
	}>;
	close(): Promise<void>;
}

export declare class StdioTransport {
	constructor(options: { command: string; args?: string[]; env?: Record<string, string> });
}

export declare class StreamableHttpTransport {
	constructor(options: { url: string; headers?: Record<string, string> });
}

export declare function createAgentSession(options: {
	cwd?: string;
	model?: unknown;
	thinkingLevel?: string;
	modelRuntime?: ModelRuntime;
	resourceLoader?: VendorResourceLoader;
	sessionManager?: SessionManager;
	customTools?: VendorToolDefinition[];
}): Promise<{ session: VendorAgentSession }>;
