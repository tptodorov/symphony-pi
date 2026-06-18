import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { LinearTrackerClient } from "./tracker.js";
import type { CodexRuntimeEvent, Issue, Logger, SymphonyConfig } from "./types.js";
import { assertInsideRoot } from "./workspace.js";

export interface RunTurnOptions {
	workspacePath: string;
	issue: Issue;
	prompt: string;
	continuationPrompts: string[];
	onEvent(event: CodexRuntimeEvent): void;
	onAfterTurn?(turnNumber: number): Promise<boolean> | boolean;
	signal?: AbortSignal;
}

interface PendingRequest {
	resolve(value: any): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export class CodexAppServerClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private rl: Interface | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private notifications: ((message: any) => void)[] = [];
	private processExitHandlers: ((error: Error) => void)[] = [];
	private activeSession: { thread_id?: string; turn_id?: string; session_id?: string } = {};

	constructor(
		private readonly config: SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async runWorker(options: RunTurnOptions): Promise<void> {
		assertInsideRoot(this.config.workspace.root, options.workspacePath);
		let threadId: string | null = null;
		try {
			await this.start(options.workspacePath, options.signal);
			options.onEvent({ event: "session_process_started", timestamp: new Date().toISOString(), codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null });
			await this.request("initialize", { clientInfo: { name: "pi_symphony", title: "pi Symphony", version: "0.1.0" } }, this.config.codex.readTimeoutMs);
			this.notify("initialized", {});
			const threadResult = await this.request("thread/start", this.threadStartParams(options.workspacePath), this.config.codex.readTimeoutMs);
			threadId = extractId(threadResult?.thread);
			if (!threadId) throw new Error("response_error: thread/start did not return thread.id");
			await this.setThreadNameIfSupported(threadId, issueDisplayName(options.issue), options.onEvent);

			for (const [index, turnPrompt] of [options.prompt, ...options.continuationPrompts].entries()) {
				const turnResult = await this.request("turn/start", this.turnStartParams(threadId, options.workspacePath, turnPrompt), this.config.codex.readTimeoutMs);
				const turnId = extractId(turnResult?.turn);
				if (!turnId) throw new Error("response_error: turn/start did not return turn.id");
				const sessionId = `${threadId}-${turnId}`;
				this.activeSession = { thread_id: threadId, turn_id: turnId, session_id: sessionId };
				options.onEvent({
					event: "session_started",
					timestamp: new Date().toISOString(),
					codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null,
					thread_id: threadId,
					turn_id: turnId,
					session_id: sessionId,
					message: index === 0 ? "first turn started" : "continuation turn started",
				});
				await this.waitForTurn(threadId, turnId, options.onEvent, options.signal);
				if (options.onAfterTurn && !(await options.onAfterTurn(index + 1))) break;
			}
		} finally {
			await this.stop();
		}
	}

	private async start(cwd: string, signal?: AbortSignal): Promise<void> {
		if (cwd !== cwd.trim()) throw new Error("invalid_workspace_cwd");
		this.proc = spawn("bash", ["-lc", this.config.codex.command], { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
		this.proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) this.logger.debug("codex stderr", { message: text.slice(0, 2_000), ...this.activeSession });
		});
		const rejectActiveRequests = (error: Error) => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(error);
			}
			this.pending.clear();
			for (const handler of [...this.processExitHandlers]) handler(error);
		};
		this.proc.on("error", (error) => {
			this.logger.debug("codex process error", { error: errorMessage(error), ...this.activeSession });
			rejectActiveRequests(normalizeProcessError(error));
		});
		this.proc.on("exit", (code, sig) => {
			rejectActiveRequests(new Error(`port_exit: codex app-server exited code=${code} signal=${sig}`));
		});
		this.rl = createInterface({ input: this.proc.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
	}

	private async stop(): Promise<void> {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("client stopped"));
		}
		this.pending.clear();
		this.processExitHandlers = [];
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

	private send(message: unknown): void {
		if (!this.proc?.stdin.writable) throw new Error("port_exit: app-server stdin is not writable");
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
		const id = this.nextId++;
		const promise = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`response_timeout: ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.send({ method, id, params });
		return promise;
	}

	private notify(method: string, params: unknown): void {
		this.send({ method, params });
	}

	private handleLine(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			this.logger.warn("malformed codex JSON", { line: line.slice(0, 2_000), ...this.activeSession });
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (pending) {
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(`response_error: ${message.error.message ?? JSON.stringify(message.error)}`));
				else pending.resolve(message.result);
				return;
			}
			if (typeof message.method === "string") {
				void this.respondToServerRequest(message);
			}
		}
		for (const handler of [...this.notifications]) handler(message);
	}

	private async respondToServerRequest(message: any): Promise<void> {
		const method = String(message.method ?? "");
		if (method === "mcpServer/elicitation/request" && this.shouldAutoApproveMcpToolCall(message.params)) {
			this.send({ id: message.id, result: { action: "accept", content: {} } });
			return;
		}
		if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request") {
			this.send({ id: message.id, error: { code: -32000, message: "turn_input_required: pi-symphony does not provide interactive user input to autonomous runs" } });
			return;
		}
		if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
			this.send({ id: message.id, result: { decision: "accept" } });
			return;
		}
		if (method === "item/permissions/requestApproval") {
			this.send({ id: message.id, result: { permissions: message.params?.permissions ?? {}, scope: "turn", strictAutoReview: false } });
			return;
		}
		if (method === "item/tool/call") {
			this.send({ id: message.id, result: await this.handleDynamicToolCall(message.params) });
			return;
		}
		this.send({ id: message.id, error: { code: -32601, message: `unsupported_tool_call: ${method}` } });
	}

	private shouldAutoApproveMcpToolCall(params: any): boolean {
		const meta = params?._meta && typeof params._meta === "object" ? params._meta : null;
		const schema = params?.requestedSchema && typeof params.requestedSchema === "object" ? params.requestedSchema : null;
		const required = Array.isArray(schema?.required) ? schema.required : [];
		const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
		return String(params?.serverName ?? "") === "atlassian" && meta?.codex_approval_kind === "mcp_tool_call" && required.length === 0 && Object.keys(properties).length === 0;
	}

	private async handleDynamicToolCall(params: any): Promise<{ success: boolean; contentItems: Array<{ type: "inputText"; text: string }> }> {
		const tool = String(params?.tool ?? "");
		if (tool !== "linear_graphql") return dynamicToolFailure(`unsupported_tool_call: ${tool || "unknown"}`);
		if (this.config.tracker.kind !== "linear") return dynamicToolFailure("linear_graphql requires tracker.kind=linear");
		const parsed = parseLinearGraphqlArgs(params?.arguments);
		if (!parsed.ok) return dynamicToolFailure(parsed.error);
		const client = new LinearTrackerClient(() => this.config, this.logger);
		const result = await client.linearGraphql(parsed.query, parsed.variables);
		return { success: result.success, contentItems: [{ type: "inputText", text: JSON.stringify(result.body ?? { error: result.error }) }] };
	}

	private waitForTurn(threadId: string, turnId: string, onEvent: (event: CodexRuntimeEvent) => void, signal?: AbortSignal): Promise<void> {
		const timeoutMs = this.config.codex.turnTimeoutMs;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.notifications = this.notifications.filter((handler) => handler !== onNotification);
				this.processExitHandlers = this.processExitHandlers.filter((handler) => handler !== onProcessExit);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (error?: Error) => {
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => finish(new Error("turn_cancelled"));
			const onProcessExit = (error: Error) => finish(error);
			const timer = setTimeout(() => finish(new Error(`turn_timeout: turn ${turnId} timed out after ${timeoutMs}ms`)), timeoutMs);
			const onNotification = (message: any) => {
				const method = String(message.method ?? "other_message");
				const params = message.params;
				const autoApprovedMcp = method === "mcpServer/elicitation/request" && this.shouldAutoApproveMcpToolCall(params);
				const event = autoApprovedMcp ? summarizeMcpApproval(params, threadId, turnId, this.proc?.pid ? String(this.proc.pid) : null) : summarizeNotification(method, params, threadId, turnId, this.proc?.pid ? String(this.proc.pid) : null);
				onEvent(event);
				if (method === "turn/completed" && extractId(params?.turn) === turnId) {
					const status = params?.turn?.status;
					if (status === "completed") finish();
					else if (status === "interrupted") finish(new Error("turn_cancelled"));
					else finish(new Error(`turn_failed: ${params?.turn?.error?.message ?? status ?? "unknown"}`));
				}
				if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput" || (method === "mcpServer/elicitation/request" && !autoApprovedMcp)) {
					finish(new Error("turn_input_required"));
				}
			};
			this.notifications.push(onNotification);
			this.processExitHandlers.push(onProcessExit);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private async setThreadNameIfSupported(threadId: string, name: string, onEvent: (event: CodexRuntimeEvent) => void): Promise<void> {
		try {
			await this.request("thread/name/set", { threadId, name }, this.config.codex.readTimeoutMs);
			onEvent({ event: "thread_name_set", timestamp: new Date().toISOString(), thread_id: threadId, message: name, codex_app_server_pid: this.proc?.pid ? String(this.proc.pid) : null });
		} catch (error) {
			this.logger.debug("codex thread naming unsupported", { error: errorMessage(error) });
		}
	}

	private threadStartParams(cwd: string): Record<string, unknown> {
		const params: Record<string, unknown> = { cwd, serviceName: "pi_symphony" };
		if (this.config.codex.approvalPolicy !== undefined) params.approvalPolicy = this.config.codex.approvalPolicy;
		if (this.config.codex.threadSandbox !== undefined) params.sandbox = this.config.codex.threadSandbox;
		const tools = this.dynamicToolSpecs();
		if (tools.length > 0) params.dynamic_tools = tools;
		return params;
	}

	private dynamicToolSpecs(): Array<Record<string, unknown>> {
		if (this.config.tracker.kind !== "linear" || !this.config.tracker.apiKey) return [];
		return [
			{
				name: "linear_graphql",
				description: "Execute one Linear GraphQL query or mutation using pi-symphony's configured Linear endpoint and auth. Input: { query: string, variables?: object }. Returns the Linear GraphQL response body, with success=false when top-level GraphQL errors are present.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Single Linear GraphQL query or mutation document." },
						variables: { type: "object", description: "Optional GraphQL variables object.", additionalProperties: true },
					},
					required: ["query"],
					additionalProperties: false,
				},
				deferLoading: false,
			},
		];
	}

	private turnStartParams(threadId: string, cwd: string, prompt: string): Record<string, unknown> {
		const params: Record<string, unknown> = { threadId, cwd, input: [{ type: "text", text: prompt }] };
		if (this.config.codex.approvalPolicy !== undefined) params.approvalPolicy = this.config.codex.approvalPolicy;
		if (this.config.codex.turnSandboxPolicy !== undefined) params.sandboxPolicy = this.config.codex.turnSandboxPolicy;
		return params;
	}
}

function summarizeNotification(method: string, params: any, threadId: string, turnId: string, pid: string | null): CodexRuntimeEvent {
	const timestamp = new Date().toISOString();
	const session_id = `${threadId}-${turnId}`;
	const usage = method === "thread/tokenUsage/updated" ? params : findUsage(params);
	return {
		event: mapEventName(method, params),
		timestamp,
		codex_app_server_pid: pid,
		thread_id: threadId,
		turn_id: turnId,
		session_id,
		message: summarizeMessage(method, params),
		usage,
		rate_limits: findRateLimits(params),
		payload: params,
	};
}

function summarizeMcpApproval(params: any, threadId: string, turnId: string, pid: string | null): CodexRuntimeEvent {
	const timestamp = new Date().toISOString();
	const session_id = `${threadId}-${turnId}`;
	const title = String(params?._meta?.tool_title ?? "MCP tool");
	return {
		event: "approval_auto_approved",
		timestamp,
		codex_app_server_pid: pid,
		thread_id: threadId,
		turn_id: turnId,
		session_id,
		message: `auto-approved atlassian MCP tool: ${title}`,
		payload: params,
	};
}

function mapEventName(method: string, params: any): string {
	if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval") return "approval_auto_approved";
	if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request") return "turn_input_required";
	if (method === "item/tool/call") return "unsupported_tool_call";
	if (method === "turn/completed") {
		const status = params?.turn?.status;
		if (status === "completed") return "turn_completed";
		if (status === "interrupted") return "turn_cancelled";
		return "turn_failed";
	}
	return method.replaceAll("/", "_");
}

function summarizeMessage(method: string, params: any): string {
	if (typeof params?.item?.text === "string") return params.item.text.slice(0, 500);
	if (typeof params?.delta === "string") return params.delta.slice(0, 500);
	if (typeof params?.turn?.error?.message === "string") return params.turn.error.message.slice(0, 500);
	return method;
}

function findUsage(value: any): unknown {
	if (!value || typeof value !== "object") return undefined;
	if (value.total_token_usage) return value.total_token_usage;
	if (value.totalTokenUsage) return value.totalTokenUsage;
	if (value.input_tokens || value.output_tokens || value.total_tokens || value.inputTokens || value.outputTokens || value.totalTokens) return value;
	for (const [key, child] of Object.entries(value)) {
		if (key === "last_token_usage" || key === "lastTokenUsage") continue;
		const found = findUsage(child);
		if (found) return found;
	}
	return undefined;
}

function findRateLimits(value: any): unknown {
	if (!value || typeof value !== "object") return undefined;
	if (value.rate_limits || value.rateLimits) return value.rate_limits ?? value.rateLimits;
	for (const child of Object.values(value)) {
		const found = findRateLimits(child);
		if (found) return found;
	}
	return undefined;
}

function parseLinearGraphqlArgs(args: unknown): { ok: true; query: string; variables: Record<string, unknown> } | { ok: false; error: string } {
	if (typeof args === "string") return args.trim() ? { ok: true, query: args, variables: {} } : { ok: false, error: "query must be non-empty" };
	if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "arguments must be an object or GraphQL query string" };
	const root = args as Record<string, unknown>;
	if (typeof root.query !== "string" || !root.query.trim()) return { ok: false, error: "query must be non-empty" };
	if (root.variables !== undefined && (!root.variables || typeof root.variables !== "object" || Array.isArray(root.variables))) return { ok: false, error: "variables must be an object" };
	return { ok: true, query: root.query, variables: (root.variables as Record<string, unknown> | undefined) ?? {} };
}

function dynamicToolFailure(error: string): { success: false; contentItems: Array<{ type: "inputText"; text: string }> } {
	return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ error }) }] };
}

function issueDisplayName(issue: Issue): string {
	return `${issue.identifier}: ${issue.title}`.slice(0, 200);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeProcessError(error: unknown): Error {
	if (error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR")) return new Error("turn_cancelled");
	return error instanceof Error ? error : new Error(String(error));
}

function extractId(value: any): string | null {
	return typeof value?.id === "string" ? value.id : null;
}
