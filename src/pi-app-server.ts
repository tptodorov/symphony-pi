import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { CodexRuntimeEvent, Issue, Logger, SymphonyConfig } from "./types.js";
import { assertInsideRoot } from "./workspace.js";

const INTERACTIVE_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FIRE_AND_FORGET_EXTENSION_UI_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

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
	private nextId = 1;
	private pending = new Map<string, PendingRequest>();
	private broadcasts: ((message: any) => void)[] = [];
	private recentBroadcasts: any[] = [];
	private activeSession: { session_id?: string; turn_id?: string } = {};
	private activePromptReject: ((error: Error) => void) | null = null;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuffer = "";
	private processOutput = "";

	constructor(
		private readonly config: SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async runWorker(options: PiRunTurnOptions): Promise<void> {
		assertInsideRoot(this.config.workspace.root, options.workspacePath);
		const fallbackSessionId = `symphony-${safeId(options.issue.identifier || options.issue.id)}-${randomUUID()}`;
		try {
			const state = await this.startRpc(options.workspacePath, options.signal);
			const sessionId = stringAt(state?.data?.sessionId) ?? fallbackSessionId;
			this.activeSession = { session_id: sessionId };
			options.onEvent({ event: "pi_rpc_process_started", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, message: "Pi RPC process started" });
			await this.request({ type: "set_session_name", name: issueDisplayName(options.issue) }, this.config.pi.readTimeoutMs, options.signal).catch((error) => this.logger.debug("pi session naming failed", { error: errorMessage(error), session_id: sessionId }));
			if (this.config.pi.modelProvider && this.config.pi.modelId) {
				await this.request({ type: "set_model", provider: this.config.pi.modelProvider, modelId: this.config.pi.modelId }, this.config.pi.readTimeoutMs, options.signal);
			}
			if (this.config.pi.thinkingLevel) {
				await this.request({ type: "set_thinking_level", level: this.config.pi.thinkingLevel }, this.config.pi.readTimeoutMs, options.signal);
			}
			await this.runPromptSequence(sessionId, options);
		} finally {
			await this.stop();
		}
	}

	private async startRpc(cwd: string, signal?: AbortSignal): Promise<any> {
		this.recentBroadcasts = [];
		this.processOutput = "";
		this.stdoutBuffer = "";
		this.stdoutDecoder = new StringDecoder("utf8");
		if (cwd !== cwd.trim()) throw new Error("invalid_workspace_cwd");
		const command = buildPiRpcCommand(this.config.pi.command);
		this.proc = spawn("bash", ["-lc", command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			signal,
			env: process.env,
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
		this.proc.stdout.on("end", () => this.flushStdoutBuffer());
		this.proc.stderr.on("data", (chunk: Buffer) => this.handleProcessOutput("stderr", chunk));
		this.installProcessExitHandlers();
		return await this.request({ type: "get_state" }, this.config.pi.readTimeoutMs, signal);
	}

	private async runPromptSequence(sessionId: string, options: PiRunTurnOptions): Promise<void> {
		for (const [index, turnPrompt] of [options.prompt, ...options.continuationPrompts].entries()) {
			const turnId = `turn-${index + 1}`;
			this.activeSession = { session_id: sessionId, turn_id: turnId };
			options.onEvent({ event: "session_started", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: index === 0 ? "first Pi RPC turn started" : "Pi RPC continuation turn started" });
			await this.runPromptTurn(sessionId, turnId, turnPrompt, options.onEvent, options.signal);
			if (options.onAfterTurn && !(await options.onAfterTurn(index + 1))) break;
		}
	}

	private installProcessExitHandlers(): void {
		this.proc?.on("error", (error) => {
			this.logger.debug("pi rpc process error", { error: errorMessage(error), ...this.activeSession });
			this.rejectActiveRequests(normalizeProcessError(error));
		});
		this.proc?.on("exit", (code, sig) => {
			this.rejectActiveRequests(new Error(`process_exit: pi rpc exited code=${code} signal=${sig}${this.processOutput.trim() ? `: ${sanitizeProcessOutput(this.processOutput)}` : ""}`));
		});
	}

	private rejectActiveRequests(error: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			this.settlePending(id, pending);
			pending.reject(error);
		}
		this.activePromptReject?.(error);
	}

	private async stop(): Promise<void> {
		for (const [id, pending] of this.pending.entries()) {
			this.settlePending(id, pending);
			pending.reject(new Error("client stopped"));
		}
		this.broadcasts = [];
		this.activePromptReject = null;
		this.activeSession = {};
		const proc = this.proc;
		this.proc = null;
		if (proc && !proc.killed) {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 2_000).unref();
		}
	}

	private async runPromptTurn(sessionId: string, turnId: string, prompt: string, onEvent: (event: CodexRuntimeEvent) => void, signal?: AbortSignal): Promise<void> {
		const onBroadcast = (message: any) => this.onBroadcast(sessionId, turnId, message, onEvent);
		const onAbort = () => this.notifyAbort();
		this.broadcasts.push(onBroadcast);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await this.request({ type: "prompt", message: prompt }, this.config.pi.readTimeoutMs, signal, onAbort);
			await this.waitForAgentEnd(turnId, signal);
			await this.emitLastAssistantMessage(sessionId, turnId, onEvent, signal);
			onEvent({ event: "turn_completed", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: "Pi RPC prompt completed" });
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.broadcasts = this.broadcasts.filter((handler) => handler !== onBroadcast);
		}
	}

	private async waitForAgentEnd(turnId: string, signal?: AbortSignal): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.activePromptReject = reject;
			this.waitForBroadcast(
				(message) => {
					const event = piEventFromBroadcast(message);
					return event?.type === "agent_end";
				},
				this.config.pi.turnTimeoutMs,
				signal,
				"agent_end",
			)
				.then(() => resolve())
				.catch((error) => reject(error))
				.finally(() => {
					this.activePromptReject = null;
				});
		});
		this.logger.debug("pi rpc agent turn ended", { turn_id: turnId, ...this.activeSession });
	}

	private async emitLastAssistantMessage(sessionId: string, turnId: string, onEvent: (event: CodexRuntimeEvent) => void, signal?: AbortSignal): Promise<void> {
		try {
			const result = await this.request({ type: "get_last_assistant_text" }, this.config.pi.readTimeoutMs, signal);
			const text = typeof result?.data?.text === "string" ? result.data.text : "";
			if (!text.trim()) return;
			onEvent({ event: "item_completed", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null, session_id: sessionId, turn_id: turnId, message: text, payload: { item: { type: "agentMessage", text } } });
		} catch (error) {
			this.logger.debug("pi last assistant text unavailable", { error: errorMessage(error), session_id: sessionId, turn_id: turnId });
		}
	}

	private onBroadcast(sessionId: string, turnId: string, message: any, onEvent: (event: CodexRuntimeEvent) => void): void {
		const event = piEventFromBroadcast(message);
		if (!event) return;
		if (isExtensionUiRequest(event)) {
			onEvent(this.runtimeEvent("pi_extension_ui_request", sessionId, turnId, summarizeExtensionUiRequest(event), event));
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
		if (!this.proc?.stdin.writable) throw new Error("process_exit: pi rpc stdin is not writable");
		if (signal?.aborted) {
			onAbort?.();
			return Promise.reject(new Error("turn_cancelled"));
		}
		const id = String(command.id ?? `cmd-${this.nextId++}`);
		const message = { ...command, id };
		const promise = this.createPendingRequest(id, String(command.type ?? "unknown"), timeoutMs, signal, onAbort);
		this.writeJson(message);
		return promise;
	}

	private createPendingRequest(id: string, command: string, timeoutMs: number, signal?: AbortSignal, onAbort?: () => void): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (pending) this.settlePending(id, pending);
				reject(new Error(`response_timeout: ${command} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onSignalAbort = () => {
				const pending = this.pending.get(id);
				if (pending) this.settlePending(id, pending);
				onAbort?.();
				reject(new Error("turn_cancelled"));
			};
			if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });
			this.pending.set(id, { command, resolve, reject, timer, signal, onAbort: onSignalAbort });
		});
	}

	private notifyAbort(): void {
		if (!this.proc?.stdin.writable) return;
		this.writeJson({ id: `abort-${this.nextId++}`, type: "abort" });
	}

	private respondToExtensionUiRequest(event: any): void {
		const requestId = typeof event.id === "string" ? event.id : typeof event.requestId === "string" ? event.requestId : null;
		if (!requestId || !this.proc?.stdin.writable) return;
		this.writeJson({ type: "extension_ui_response", id: requestId, cancelled: true });
	}

	private writeJson(message: Record<string, unknown>): void {
		this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private settlePending(id: string, pending: PendingRequest): void {
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		this.pending.delete(id);
	}

	private handleStdoutChunk(chunk: Buffer): void {
		this.consumeStdout(this.stdoutDecoder.write(chunk));
	}

	private flushStdoutBuffer(): void {
		this.consumeStdout(this.stdoutDecoder.end());
		if (this.stdoutBuffer.length > 0) {
			const line = this.stdoutBuffer.endsWith("\r") ? this.stdoutBuffer.slice(0, -1) : this.stdoutBuffer;
			this.stdoutBuffer = "";
			this.handleLine(line);
		}
	}

	private consumeStdout(text: string): void {
		this.processOutput += text;
		this.stdoutBuffer += text;
		while (true) {
			const newlineIndex = this.stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) break;
			let line = this.stdoutBuffer.slice(0, newlineIndex);
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.handleLine(line);
		}
	}

	private handleProcessOutput(stream: "stderr", chunk: Buffer): void {
		const text = chunk.toString("utf8");
		this.processOutput += text;
		const trimmed = text.trim();
		if (trimmed) this.logger.debug(`pi rpc ${stream}`, { message: trimmed.slice(0, 2_000), ...this.activeSession });
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.logger.debug("malformed pi rpc JSON", { line: line.slice(0, 2_000), ...this.activeSession });
			return;
		}
		this.handleProtocolMessage(message);
	}

	private handleProtocolMessage(message: any): void {
		if (isExtensionUiRequest(message)) this.respondToExtensionUiRequest(message);
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
		if (this.recentBroadcasts.length > 50) this.recentBroadcasts.splice(0, this.recentBroadcasts.length - 50);
		for (const handler of [...this.broadcasts]) handler(message);
	}

	private waitForBroadcast(predicate: (message: any) => boolean, timeoutMs: number, signal?: AbortSignal, label = "event"): Promise<any> {
		try {
			const existing = this.recentBroadcasts.find((message) => predicate(message));
			if (existing) return Promise.resolve(existing);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(undefined, new Error(`response_timeout: ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			const onAbort = () => finish(undefined, new Error("turn_cancelled"));
			const handler = (message: any) => {
				try {
					if (predicate(message)) finish(message);
				} catch (error) {
					finish(undefined, error instanceof Error ? error : new Error(String(error)));
				}
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

function buildPiRpcCommand(command: string): string {
	const trimmed = command.trim();
	if (/(^|\s)--mode(?:=|\s+)rpc(?=\s|$)/.test(trimmed)) return trimmed;
	return `${trimmed} --mode rpc`;
}

function piEventFromBroadcast(message: any): any | null {
	if (!message || typeof message !== "object") return null;
	if (message.type === "event" && message.event && typeof message.event === "object") return message.event;
	if (typeof message.type === "string" && message.type !== "response") return message;
	return null;
}

function isExtensionUiRequest(event: any): boolean {
	return event?.type === "extension_ui_request";
}

function isInteractiveExtensionUiRequest(event: any): boolean {
	if (!isExtensionUiRequest(event)) return false;
	const method = String(event.method ?? "");
	if (!method) return true;
	if (FIRE_AND_FORGET_EXTENSION_UI_METHODS.has(method)) return false;
	return INTERACTIVE_EXTENSION_UI_METHODS.has(method) || true;
}

function safeId(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "issue";
}

function issueDisplayName(issue: Issue): string {
	return `${issue.identifier}: ${issue.title}`;
}

function summarizeExtensionUiRequest(event: any): string {
	const method = typeof event.method === "string" ? event.method : "unknown";
	return isInteractiveExtensionUiRequest(event) ? `Pi extension UI requested ${method}; cancelled for autonomous run` : `Pi extension UI ${method}`;
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
	if (error.code === "ENOENT") return new Error("process_exit: pi rpc command not found");
	return error;
}

function stringAt(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function sanitizeProcessOutput(text: string, max = 2_000): string {
	const redacted = text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[redacted]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
	return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
