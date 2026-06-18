import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createInterface, type Interface } from "node:readline";

import type { CodexRuntimeEvent, Issue, Logger, SymphonyConfig } from "./types.js";
import { assertInsideRoot } from "./workspace.js";

export interface PiRunTurnOptions {
	workspacePath: string;
	issue: Issue;
	prompt: string;
	continuationPrompts: string[];
	onEvent(event: CodexRuntimeEvent): void;
	onAfterTurn?(turnNumber: number): Promise<boolean> | boolean;
	signal?: AbortSignal;
}

interface PendingRequest {
	command: string;
	resolve(value: any): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class PiAppServerClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private rl: Interface | null = null;
	private nextId = 1;
	private pending = new Map<string, PendingRequest>();
	private broadcasts: ((message: any) => void)[] = [];
	private recentBroadcasts: any[] = [];
	private activeSession: { session_id?: string; turn_id?: string } = {};

	constructor(
		private readonly config: SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async runWorker(options: PiRunTurnOptions): Promise<void> {
		assertInsideRoot(this.config.workspace.root, options.workspacePath);
		const sessionId = `symphony-${safeId(options.issue.identifier || options.issue.id)}-${randomUUID()}`;
		try {
			await this.start(options.workspacePath, options.signal);
			options.onEvent({ event: "pi_server_process_started", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, message: "pi-server process started" });
			await this.request({ type: "create_session", sessionId, cwd: options.workspacePath }, this.config.pi.readTimeoutMs, options.signal);
			await this.request({ type: "switch_session", sessionId }, this.config.pi.readTimeoutMs, options.signal);
			await this.request({ type: "set_session_name", sessionId, name: issueDisplayName(options.issue) }, this.config.pi.readTimeoutMs, options.signal).catch((error) => this.logger.debug("pi session naming failed", { error: errorMessage(error), session_id: sessionId }));
			if (this.config.pi.modelProvider && this.config.pi.modelId) {
				await this.request({ type: "set_model", sessionId, provider: this.config.pi.modelProvider, modelId: this.config.pi.modelId }, this.config.pi.readTimeoutMs, options.signal);
			}
			if (this.config.pi.thinkingLevel) {
				await this.request({ type: "set_thinking_level", sessionId, level: this.config.pi.thinkingLevel }, this.config.pi.readTimeoutMs, options.signal);
			}

			for (const [index, turnPrompt] of [options.prompt, ...options.continuationPrompts].entries()) {
				const turnId = `turn-${index + 1}`;
				this.activeSession = { session_id: sessionId, turn_id: turnId };
				options.onEvent({ event: "session_started", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: index === 0 ? "first Pi turn started" : "Pi continuation turn started" });
				await this.runPromptTurn(sessionId, turnId, turnPrompt, options.onEvent, options.signal);
				if (options.onAfterTurn && !(await options.onAfterTurn(index + 1))) break;
			}
		} finally {
			await this.stop();
		}
	}

	private async start(cwd: string, signal?: AbortSignal): Promise<void> {
		if (cwd !== cwd.trim()) throw new Error("invalid_workspace_cwd");
		const port = this.config.pi.serverPort ?? (await freePort());
		this.proc = spawn("bash", ["-lc", this.config.pi.command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			signal,
			env: { ...process.env, PI_SERVER_PORT: String(port) },
		});
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) this.logger.debug("pi-server stderr", { message: text.slice(0, 2_000), ...this.activeSession });
		});
		const rejectActiveRequests = (error: Error) => {
			for (const [id, pending] of this.pending.entries()) {
				this.settlePending(id, pending);
				pending.reject(error);
			}
		};
		this.proc.on("error", (error) => {
			this.logger.debug("pi-server process error", { error: errorMessage(error), ...this.activeSession });
			rejectActiveRequests(normalizeProcessError(error));
		});
		this.proc.on("exit", (code, sig) => {
			rejectActiveRequests(new Error(`port_exit: pi-server exited code=${code} signal=${sig}`));
		});
		this.rl = createInterface({ input: this.proc.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
		await this.waitForBroadcast((message) => message?.type === "server_ready", this.config.pi.readTimeoutMs, signal);
	}

	private async stop(): Promise<void> {
		for (const [id, pending] of this.pending.entries()) {
			this.settlePending(id, pending);
			pending.reject(new Error("client stopped"));
		}
		this.broadcasts = [];
		this.activeSession = {};
		this.rl?.close();
		this.rl = null;
		const proc = this.proc;
		this.proc = null;
		if (proc && !proc.killed) {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 2_000).unref();
		}
	}

	private async runPromptTurn(sessionId: string, turnId: string, prompt: string, onEvent: (event: CodexRuntimeEvent) => void, signal?: AbortSignal): Promise<void> {
		const onBroadcast = (message: any) => this.onBroadcast(sessionId, turnId, message, onEvent);
		this.broadcasts.push(onBroadcast);
		try {
			await this.request(
				{ type: "prompt", sessionId, message: prompt },
				this.config.pi.turnTimeoutMs,
				signal,
				() => {
					this.notifyAbort(sessionId);
				},
			);
			await this.emitLastAssistantMessage(sessionId, turnId, onEvent, signal);
			onEvent({ event: "turn_completed", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: "Pi prompt completed" });
		} finally {
			this.broadcasts = this.broadcasts.filter((handler) => handler !== onBroadcast);
		}
	}

	private async emitLastAssistantMessage(sessionId: string, turnId: string, onEvent: (event: CodexRuntimeEvent) => void, signal?: AbortSignal): Promise<void> {
		try {
			const result = await this.request({ type: "get_last_assistant_text", sessionId }, this.config.pi.readTimeoutMs, signal);
			const text = typeof result?.data?.text === "string" ? result.data.text : "";
			if (!text.trim()) return;
			onEvent({ event: "item_completed", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: text, payload: { item: { type: "agentMessage", text } } });
		} catch (error) {
			this.logger.debug("pi last assistant text unavailable", { error: errorMessage(error), session_id: sessionId, turn_id: turnId });
		}
	}

	private onBroadcast(sessionId: string, turnId: string, message: any, onEvent: (event: CodexRuntimeEvent) => void): void {
		if (message?.type !== "event" || message.sessionId !== sessionId) return;
		const event = message.event ?? {};
		if (event.type === "extension_ui_request") {
			if (typeof event.requestId === "string" && !event.requestId.startsWith("notify-") && !event.requestId.startsWith("status-")) {
				void this.request({ type: "extension_ui_response", sessionId, requestId: event.requestId, response: { method: "cancelled" } }, this.config.pi.readTimeoutMs).catch((error) => this.logger.debug("pi extension UI cancellation failed", { error: errorMessage(error), session_id: sessionId }));
				this.failPendingPrompt(sessionId, new Error("turn_input_required"));
			}
			onEvent(this.runtimeEvent("turn_input_required", sessionId, turnId, "Pi extension UI requested interactive input", event));
			return;
		}
		const runtimeEvent = this.runtimeEvent(`pi_${String(event.type ?? "event")}`, sessionId, turnId, summarizePiMessage(event), event);
		const usage = extractUsage(event);
		if (usage) runtimeEvent.usage = usage;
		onEvent(runtimeEvent);
	}

	private runtimeEvent(event: string, sessionId: string, turnId: string, message?: string, payload?: unknown): CodexRuntimeEvent {
		return { event, timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message, payload };
	}

	private request(command: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal, onAbort?: () => void): Promise<any> {
		if (!this.proc?.stdin.writable) throw new Error("port_exit: pi-server stdin is not writable");
		if (signal?.aborted) {
			onAbort?.();
			return Promise.reject(new Error("turn_cancelled"));
		}
		const id = String(command.id ?? `cmd-${this.nextId++}`);
		const message = { ...command, id };
		const promise = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (pending) this.settlePending(id, pending);
				reject(new Error(`response_timeout: ${String(command.type)} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onSignalAbort = () => {
				const pending = this.pending.get(id);
				if (pending) this.settlePending(id, pending);
				onAbort?.();
				reject(new Error("turn_cancelled"));
			};
			if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });
			this.pending.set(id, { command: String(command.type ?? "unknown"), resolve, reject, timer, signal, onAbort: onSignalAbort });
		});
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
		return promise;
	}

	private notifyAbort(sessionId: string): void {
		if (!this.proc?.stdin.writable) return;
		const id = `abort-${this.nextId++}`;
		this.proc.stdin.write(`${JSON.stringify({ id, type: "abort", sessionId })}\n`);
	}

	private failPendingPrompt(sessionId: string, error: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			if (pending.command !== "prompt") continue;
			this.settlePending(id, pending);
			pending.reject(error);
		}
		this.notifyAbort(sessionId);
	}

	private settlePending(id: string, pending: PendingRequest): void {
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		this.pending.delete(id);
	}

	private handleLine(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.logger.debug("malformed pi-server JSON", { line: line.slice(0, 2_000), ...this.activeSession });
			return;
		}
		if (message?.type === "response" && message.id !== undefined) {
			const id = String(message.id);
			const pending = this.pending.get(id);
			if (pending) {
				this.settlePending(id, pending);
				if (message.success === false) pending.reject(new Error(`response_error: ${message.error ?? JSON.stringify(message)}`));
				else pending.resolve(message);
				return;
			}
		}
		this.recentBroadcasts.push(message);
		if (this.recentBroadcasts.length > 20) this.recentBroadcasts.splice(0, this.recentBroadcasts.length - 20);
		for (const handler of [...this.broadcasts]) handler(message);
	}

	private waitForBroadcast(predicate: (message: any) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<any> {
		const existing = this.recentBroadcasts.find((message) => predicate(message));
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(undefined, new Error(`response_timeout: pi-server ready timed out after ${timeoutMs}ms`)), timeoutMs);
			const onAbort = () => finish(undefined, new Error("turn_cancelled"));
			const handler = (message: any) => {
				if (predicate(message)) finish(message);
			};
			const finish = (message?: any, error?: Error) => {
				clearTimeout(timer);
				this.broadcasts = this.broadcasts.filter((candidate) => candidate !== handler);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(message);
			};
			this.broadcasts.push(handler);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function safeId(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "issue";
}

function issueDisplayName(issue: Issue): string {
	return `${issue.identifier}: ${issue.title}`;
}

function summarizePiMessage(event: any): string {
	if (typeof event.message === "string") return event.message;
	if (typeof event.text === "string") return event.text;
	if (typeof event.type === "string") return event.type;
	return "Pi event";
}

function extractUsage(event: any): unknown {
	const message = event?.message && typeof event.message === "object" ? event.message : null;
	return event?.usage ?? message?.usage ?? null;
}

function normalizeProcessError(error: NodeJS.ErrnoException): Error {
	if (error.code === "ENOENT") return new Error("port_exit: pi-server command not found");
	return error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
