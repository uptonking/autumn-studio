import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcProcessOptions {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export type RpcEventListener = (event: Record<string, unknown>) => void;

/**
 * Manages a Pi child process in JSON-RPC mode.
 * Communicates via JSON lines over stdin/stdout, correlates requests by `id`,
 * and forwards asynchronous events to subscribers.
 */
export class RpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		string,
		{ resolve: (val: any) => void; reject: (err: Error) => void }
	>();
	private readonly eventListeners = new Set<RpcEventListener>();
	private nextId = 1;
	private stderr = "";
	private closed = false;

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
					} catch (e) {
						console.warn("autumn-studio: unparseable line from pi:", line);
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});

		this.child.on("exit", (code, signal) => {
			this.closed = true;
			const exitError = new Error(
				`Pi process exited (code=${code}, signal=${signal}): ${this.stderr}`.trim(),
			);
			for (const req of this.pending.values()) {
				req.reject(exitError);
			}
			this.pending.clear();
		});

		this.child.on("error", (err) => {
			for (const req of this.pending.values()) {
				req.reject(err);
			}
			this.pending.clear();
		});
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
	 */
	async request<T = unknown>(
		command: Record<string, unknown>,
		timeoutMs: number = 30000,
	): Promise<T> {
		if (this.closed) throw new Error("Pi process is already closed");
		const id = `req-${this.nextId++}`;
		const payload = { ...command, id };

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

			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		});
	}

	/**
	 * Subscribe to streaming events from the Pi process.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	getStderr(): string {
		return this.stderr;
	}

	async close(gracePeriodMs = 2000): Promise<void> {
		if (this.closed) return;
		this.closed = true;

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
				this.child.stdin.end();
				this.child.kill("SIGTERM");
			} catch {
				clearTimeout(forceKillTimer);
				resolve();
			}
		});
	}
}
