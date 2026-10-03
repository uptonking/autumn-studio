import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcProcessOptions {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export type RpcEventListener = (event: Record<string, unknown>) => void;
export type RpcExitListener = (error: Error) => void;

/**
 * Manages a Pi child process in RPC mode. Communicates via JSON lines over
 * stdin/stdout, correlates requests by `id`, and forwards asynchronous events
 * to subscribers.
 *
 * Lifecycle note: pi's RPC mode shuts down when its stdin closes, so an
 * orphaned child (plugin process died without cleanup) exits on its own once
 * the OS closes the pipes. `close()` makes the normal path explicit with a
 * SIGTERM grace period and a SIGKILL backstop.
 */
export class RpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		string,
		{ resolve: (val: any) => void; reject: (err: Error) => void }
	>();
	private readonly eventListeners = new Set<RpcEventListener>();
	private readonly exitListeners = new Set<RpcExitListener>();
	private readonly writeQueue: string[] = [];
	private nextId = 1;
	private stderr = "";
	private closed = false;
	private exitError: Error | null = null;
	private stdinPaused = false;

	constructor(options: RpcProcessOptions) {
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-8192);
		});

		let buffer = "";
		this.child.stdout.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line) {
					try {
						const msg = JSON.parse(line) as Record<string, unknown>;
						this.handleMessage(msg);
					} catch {
						console.warn("autumn-studio: unparseable line from pi:", line.slice(0, 200));
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});

		this.child.stdin.on("drain", () => {
			this.stdinPaused = false;
			this.pumpWrites();
		});
		// Killing the child with queued writes surfaces EPIPE here; without a
		// listener the error event would crash the plugin process. Real failure
		// reporting happens through the exit handler and pending rejection.
		this.child.stdin.on("error", () => {});

		this.child.on("exit", (code, signal) => {
			this.failAll(
				new Error(
					`Pi process exited (code=${code}, signal=${signal}): ${this.stderr}`.trim(),
				),
			);
		});

		this.child.on("error", (err) => {
			this.failAll(err instanceof Error ? err : new Error(String(err)));
		});
	}

	private failAll(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.exitError = error;
		this.writeQueue.length = 0;
		for (const req of this.pending.values()) {
			req.reject(error);
		}
		this.pending.clear();
		for (const listener of this.exitListeners) {
			try {
				listener(error);
			} catch (err) {
				console.error("autumn-studio: error in rpc exit listener:", err);
			}
		}
	}

	/**
	 * Rejects every in-flight request. close() calls this directly — the child
	 * exit event must not be the only path, or a close() racing an in-flight
	 * request would hang that request forever (failAll early-returns once
	 * closed is set).
	 */
	private rejectPending(error: Error): void {
		this.writeQueue.length = 0;
		for (const req of this.pending.values()) {
			req.reject(error);
		}
		this.pending.clear();
	}

	private pumpWrites(): void {
		while (!this.stdinPaused && this.writeQueue.length > 0) {
			const line = this.writeQueue.shift();
			if (line === undefined) break;
			const ok = this.child.stdin.write(line);
			if (!ok) this.stdinPaused = true;
		}
	}

	private enqueue(line: string): void {
		this.writeQueue.push(line);
		this.pumpWrites();
	}

	private handleMessage(msg: Record<string, unknown>) {
		if (msg.type === "response" && typeof msg.id === "string") {
			const pending = this.pending.get(msg.id);
			if (pending) {
				this.pending.delete(msg.id);
				if (msg.success === false) {
					pending.reject(new Error((msg.error as string) || "RPC command failed"));
				} else {
					pending.resolve(msg.data);
				}
				return;
			}
		}

		// Asynchronous session events
		for (const listener of this.eventListeners) {
			try {
				listener(msg);
			} catch (err) {
				console.error("autumn-studio: error in rpc event listener:", err);
			}
		}
	}

	/**
	 * Send an RPC command to the child process and await its matching response.
	 * A timeoutMs of 0 waits indefinitely (for commands like compact).
	 */
	async request<T = unknown>(
		command: Record<string, unknown>,
		timeoutMs: number = 30000,
	): Promise<T> {
		if (this.closed) {
			throw this.exitError ?? new Error("Pi process is already closed");
		}
		const id = `req-${this.nextId++}`;
		this.enqueue(`${JSON.stringify({ ...command, id })}\n`);

		return new Promise<T>((resolve, reject) => {
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.pending.delete(id);
					reject(
						new Error(
							`Pi RPC timeout after ${timeoutMs}ms for command: ${command.type}`,
						),
					);
				}, timeoutMs);
			}

			this.pending.set(id, {
				resolve: (val) => {
					if (timer) clearTimeout(timer);
					resolve(val as T);
				},
				reject: (err) => {
					if (timer) clearTimeout(timer);
					reject(err);
				},
			});
		});
	}

	/**
	 * Write a fire-and-forget frame (no response is correlated, e.g. the
	 * extension_ui_response subprotocol). Silent no-op after close.
	 */
	notify(frame: Record<string, unknown>): void {
		if (this.closed) return;
		this.enqueue(`${JSON.stringify(frame)}\n`);
	}

	/**
	 * Subscribe to streaming events from the Pi process.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	/**
	 * Subscribe to child exit. Invoked immediately if the process already died.
	 */
	onExit(listener: RpcExitListener): () => void {
		this.exitListeners.add(listener);
		if (this.exitError) listener(this.exitError);
		return () => this.exitListeners.delete(listener);
	}

	getStderr(): string {
		return this.stderr;
	}

	async close(gracePeriodMs = 2000): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.rejectPending(new Error("Pi process is closing"));
		this.exitError ??= new Error("Pi process closed");
		this.writeQueue.length = 0;

		return new Promise<void>((resolve) => {
			const forceKillTimer = setTimeout(() => {
				try {
					this.child.kill("SIGKILL");
				} catch {}
				resolve();
			}, gracePeriodMs);

			this.child.once("exit", () => {
				clearTimeout(forceKillTimer);
				resolve();
			});

			try {
				// stdin end is pi's graceful-shutdown trigger; SIGTERM covers a hung shutdown.
				this.child.stdin.end();
				this.child.kill("SIGTERM");
			} catch {
				clearTimeout(forceKillTimer);
				resolve();
			}
		});
	}
}
