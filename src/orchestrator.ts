import { appendFileSync, watch, type FSWatcher } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadResolvedConfig, normalizeState, validateDispatchConfig } from "./config.js";
import { CodexAppServerClient } from "./codex.js";
import { evaluateIssueEligibility, runtimeStateFromOrchestratorState, sortIssuesForDispatch, type EligibilityResult } from "./eligibility.js";
import { SymphonyHttpServer } from "./http.js";
import { PiAppServerClient } from "./pi-app-server.js";
import { renderPromptTemplate } from "./template.js";
import { createTrackerAdapter, type TrackerAdapter } from "./tracker.js";
import type { CodexRuntimeEvent, Issue, Logger, OrchestratorState, RunningEntry, RunStatus, RunTerminalReason, SymphonyConfig, WorkflowDefinition } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const CONTINUATION_PROMPT = "Continue working on the same issue. Re-check the tracker state and move the issue toward the workflow-defined handoff state. Do not repeat context already present in this thread.";
const RECENT_EVENT_LIMIT = 50;
const RECENT_AGENT_MESSAGE_LIMIT = 6;
const MAX_AGENT_MESSAGE_CHARS = 6_000;
const OBSERVED_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const OBSERVED_QUEUE_LIMIT = 100;

export interface SymphonyOrchestratorOptions {
	portOverride?: number;
}

export interface RunOnceResult {
	issueIdentifier: string;
	workspacePath: string | null;
	artifactPath: string | null;
}

export interface QueueIssueSnapshot {
	issue: Issue;
	eligibility: EligibilityResult;
}

export interface QueueSnapshot {
	eligible: QueueIssueSnapshot[];
	notDispatchable: QueueIssueSnapshot[];
	recentlyChanged: QueueIssueSnapshot[];
	retrying: unknown[];
	fetched_at: string;
	error: string | null;
}

interface ObservedQueueIssue {
	issue: Issue;
	last_seen_at_ms: number;
	reason: "candidate" | "dispatched" | "worker_exit" | "observed_refresh";
}

export class SymphonyOrchestrator {
	readonly state: OrchestratorState;
	private workflow: WorkflowDefinition | null = null;
	private config: SymphonyConfig | null = null;
	private tracker: TrackerAdapter;
	private workspace: WorkspaceManager;
	private tickTimer: NodeJS.Timeout | null = null;
	private watcher: FSWatcher | null = null;
	private stopped = true;
	private stopping = false;
	private tickInFlight = false;
	private reloadError: string | null = null;
	private lastReloadAt: string | null = null;
	private httpServer: SymphonyHttpServer | null = null;
	private observedQueueIssues = new Map<string, ObservedQueueIssue>();

	constructor(
		private readonly cwd: string,
		private readonly explicitWorkflowPath: string | undefined,
		private readonly logger: Logger,
		private readonly options: SymphonyOrchestratorOptions = {},
	) {
		this.state = {
			poll_interval_ms: 30_000,
			max_concurrent_agents: 10,
			running: new Map(),
			claimed: new Set(),
			retry_attempts: new Map(),
			completed: new Set(),
			codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
			codex_rate_limits: null,
		};
		this.tracker = {
			fetchCandidateIssues: async () => {
				throw new Error("tracker not loaded");
			},
			fetchIssuesByStates: async () => {
				throw new Error("tracker not loaded");
			},
			fetchIssueStatesByIds: async () => {
				throw new Error("tracker not loaded");
			},
		};
		this.workspace = new WorkspaceManager(() => this.requireConfig(), logger);
	}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopping = false;
		await this.reload(true);
		validateDispatchConfig(this.requireConfig());
		this.startWorkflowWatcher();
		await this.startHttpServerIfConfigured();
		await this.startupTerminalWorkspaceCleanup();
		this.stopped = false;
		this.scheduleTick(0);
		this.logger.info("daemon started", { workflow: this.requireConfig().workflowPath });
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.stopped = true;
		if (this.tickTimer) clearTimeout(this.tickTimer);
		this.tickTimer = null;
		this.watcher?.close();
		this.watcher = null;
		await this.httpServer?.stop();
		this.httpServer = null;
		for (const retry of this.state.retry_attempts.values()) clearTimeout(retry.timer_handle);
		this.state.retry_attempts.clear();
		for (const entry of this.state.running.values()) entry.abort.abort();
		await Promise.allSettled([...this.state.running.values()].map((entry) => entry.promise));
		this.logger.info("daemon stopped");
	}

	async runOnce(selector?: string): Promise<RunOnceResult> {
		this.stopping = false;
		await this.reload(true);
		validateDispatchConfig(this.requireConfig());
		const issues = await this.tracker.fetchCandidateIssues();
		const issue = selector ? issues.find((candidate) => candidate.id === selector || candidate.identifier === selector) : sortIssuesForDispatch(issues).find((candidate) => this.shouldDispatch(candidate));
		if (!issue) throw new Error(this.formatNoCandidateError(selector, issues.length));
		return this.dispatchAndWait(issue, null);
	}

	async refreshNow(): Promise<void> {
		await this.tick();
	}

	getWorkflowPath(): string | null {
		return this.config?.workflowPath ?? null;
	}

	getConfig(): SymphonyConfig | null {
		return this.config;
	}

	async refreshIssueDetails(issue: Issue): Promise<Issue | null> {
		const [fresh] = await this.tracker.fetchIssueStatesByIds([issue.id]);
		if (fresh) this.observeQueueIssue(fresh, "observed_refresh");
		return fresh ?? null;
	}

	async queueSnapshot(): Promise<QueueSnapshot> {
		try {
			const issues = sortIssuesForDispatch(await this.tracker.fetchCandidateIssues());
			const activeIds = new Set(issues.map((issue) => issue.id));
			for (const issue of issues) this.observeQueueIssue(issue, "candidate");
			await this.refreshObservedQueueIssues(activeIds);
			const runtime = runtimeStateFromOrchestratorState(this.state);
			const rows = issues.map((issue) => ({ issue, eligibility: evaluateIssueEligibility(issue, runtime, this.requireConfig()) }));
			const recentlyChanged = [...this.observedQueueIssues.values()]
				.filter((entry) => !activeIds.has(entry.issue.id))
				.sort((a, b) => b.last_seen_at_ms - a.last_seen_at_ms)
				.map((entry) => ({ issue: entry.issue, eligibility: evaluateIssueEligibility(entry.issue, runtime, this.requireConfig()) }));
			return {
				eligible: rows.filter((row) => row.eligibility.eligible),
				notDispatchable: rows.filter((row) => !row.eligibility.eligible),
				recentlyChanged,
				retrying: this.retryRows(),
				fetched_at: new Date().toISOString(),
				error: null,
			};
		} catch (error) {
			return { eligible: [], notDispatchable: [], recentlyChanged: [], retrying: this.retryRows(), fetched_at: new Date().toISOString(), error: errorMessage(error) };
		}
	}

	getHttpAddress(): { enabled: boolean; port: number | null } {
		const configured = this.options.portOverride ?? this.config?.server.port;
		return { enabled: Boolean(this.httpServer), port: configured ?? null };
	}

	snapshot(): unknown {
		const now = Date.now();
		return {
			generated_at: new Date(now).toISOString(),
			counts: { running: this.state.running.size, retrying: this.state.retry_attempts.size },
			running: [...this.state.running.values()].map((entry) => runningRow(entry)),
			retrying: [...this.state.retry_attempts.values()].map((retry) => ({
				issue_id: retry.issue_id,
				issue_identifier: retry.identifier,
				attempt: retry.attempt,
				due_at: new Date(Date.now() + Math.max(retry.due_at_ms - performance.now(), 0)).toISOString(),
				error: retry.error,
				artifact_path: retry.artifact_path ?? null,
				artifacts: retry.artifact_path ? artifactPaths(retry.artifact_path) : null,
				logs: retry.artifact_path ? artifactLogs(retry.artifact_path) : { codex_session_logs: [] },
				terminal_reason: retry.terminal_reason ?? null,
			})),
			codex_totals: {
				...this.state.codex_totals,
				seconds_running: this.state.codex_totals.seconds_running + [...this.state.running.values()].reduce((sum, entry) => sum + (now - Date.parse(entry.started_at)) / 1000, 0),
			},
			rate_limits: this.state.codex_rate_limits,
			last_reload_error: this.reloadError,
			workflow_path: this.config?.workflowPath ?? null,
			workflow_dir: this.config?.workflowDir ?? null,
			tracker_kind: this.config?.tracker.kind ?? null,
			max_concurrent_agents: this.config?.agent.maxConcurrentAgents ?? null,
			poll_interval_ms: this.config?.polling.intervalMs ?? null,
			last_reload_at: this.lastReloadAt,
			http: this.getHttpAddress(),
		};
	}

	private retryRows(): unknown[] {
		return [...this.state.retry_attempts.values()].map((retry) => ({
			issue_id: retry.issue_id,
			issue_identifier: retry.identifier,
			attempt: retry.attempt,
			due_at: new Date(Date.now() + Math.max(retry.due_at_ms - performance.now(), 0)).toISOString(),
			error: retry.error,
			artifact_path: retry.artifact_path ?? null,
			artifacts: retry.artifact_path ? artifactPaths(retry.artifact_path) : null,
			logs: retry.artifact_path ? artifactLogs(retry.artifact_path) : { codex_session_logs: [] },
			terminal_reason: retry.terminal_reason ?? null,
		}));
	}

	issueSnapshot(identifier: string): unknown | null {
		const running = [...this.state.running.values()].find((entry) => entry.identifier === identifier || entry.issue.id === identifier);
		const retry = [...this.state.retry_attempts.values()].find((entry) => entry.identifier === identifier || entry.issue_id === identifier);
		if (!running && !retry) return null;
		const issueId = running?.issue.id ?? retry?.issue_id;
		const issueIdentifier = running?.identifier ?? retry?.identifier;
		return {
			issue_identifier: issueIdentifier,
			issue_id: issueId,
			status: running ? "running" : "retrying",
			terminal_reason: running?.terminal_reason ?? retry?.terminal_reason ?? null,
			workspace: { path: running?.workspace_path ?? (running ? null : this.workspace.workspacePathForIdentifier(retry!.identifier)) },
			artifacts: running?.artifact_path ? artifactPaths(running.artifact_path) : retry?.artifact_path ? artifactPaths(retry.artifact_path) : null,
			attempts: {
				restart_count: running?.retry_attempt ?? retry?.attempt ?? 0,
				current_retry_attempt: retry?.attempt ?? running?.retry_attempt ?? null,
			},
			running: running ? runningRow(running) : null,
			retry: retry
				? {
						attempt: retry.attempt,
						due_at: new Date(Date.now() + Math.max(retry.due_at_ms - performance.now(), 0)).toISOString(),
						error: retry.error,
						terminal_reason: retry.terminal_reason ?? null,
					}
				: null,
			logs: running?.artifact_path ? artifactLogs(running.artifact_path) : retry?.artifact_path ? artifactLogs(retry.artifact_path) : { codex_session_logs: [] },
			recent_events: running?.recent_events ?? [],
			recent_agent_messages: running?.recent_agent_messages ?? [],
			last_error: running?.last_error ?? retry?.error ?? null,
			tracked: {},
		};
	}

	private async tick(): Promise<void> {
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			await this.reload(false);
			await this.reconcileRunningIssues();
			try {
				validateDispatchConfig(this.requireConfig());
			} catch (error) {
				this.logger.error("dispatch validation failed", { error: errorMessage(error) });
				return;
			}
			let issues: Issue[];
			try {
				issues = await this.tracker.fetchCandidateIssues();
			} catch (error) {
				this.logger.error("candidate fetch failed", { error: errorMessage(error) });
				return;
			}
			for (const issue of sortIssuesForDispatch(issues)) {
				if (this.availableGlobalSlots() <= 0) break;
				if (this.shouldDispatch(issue)) this.dispatch(issue, null);
			}
		} finally {
			this.tickInFlight = false;
			if (!this.stopped) this.scheduleTick(this.requireConfig().polling.intervalMs);
		}
	}

	private scheduleTick(delayMs: number): void {
		if (this.tickTimer) clearTimeout(this.tickTimer);
		this.tickTimer = setTimeout(() => void this.tick(), delayMs);
	}

	private async reload(failOnError: boolean): Promise<boolean> {
		try {
			const { workflow, config } = await loadResolvedConfig(this.cwd, this.explicitWorkflowPath);
			const oldKind = this.config?.tracker.kind;
			this.workflow = workflow;
			this.config = config;
			if (oldKind !== config.tracker.kind) this.tracker = createTrackerAdapter(() => this.requireConfig(), this.logger);
			this.state.poll_interval_ms = config.polling.intervalMs;
			this.state.max_concurrent_agents = config.agent.maxConcurrentAgents;
			this.reloadError = null;
			this.lastReloadAt = new Date().toISOString();
			return true;
		} catch (error) {
			this.reloadError = errorMessage(error);
			this.logger.error("workflow reload failed", { error: this.reloadError });
			if (failOnError || !this.config) throw error;
			return false;
		}
	}

	private startWorkflowWatcher(): void {
		this.watcher?.close();
		const workflowPath = this.requireConfig().workflowPath;
		this.watcher = watch(workflowPath, { persistent: false }, () => {
			void this.reload(false).then((ok) => {
				if (ok) this.logger.info("workflow change reloaded", { workflow: workflowPath });
			});
		});
	}

	private formatNoCandidateError(selector: string | undefined, candidateCount: number): string {
		const config = this.requireConfig();
		const scope = config.tracker.kind === "linear" ? `Linear project_slug=${config.tracker.projectSlug}` : `${config.tracker.kind} tracker`;
		const states = config.tracker.activeStates.join(", ");
		if (selector) {
			return `No active candidate issue found for ${selector}. Fetched ${candidateCount} candidate(s) from ${scope} with active_states=[${states}]. Ensure the issue is in that project/scope and its state name exactly matches one of active_states.`;
		}
		return `No dispatch-eligible issue found. Fetched ${candidateCount} candidate(s) from ${scope} with active_states=[${states}].`;
	}

	private async startHttpServerIfConfigured(): Promise<void> {
		const port = this.options.portOverride ?? this.requireConfig().server.port;
		if (port === undefined) return;
		this.httpServer = new SymphonyHttpServer({
			port,
			snapshot: () => this.snapshot(),
			issueSnapshot: (identifier) => this.issueSnapshot(identifier),
			queueSnapshot: () => this.queueSnapshot(),
			refresh: () => this.refreshNow(),
		});
		const address = await this.httpServer.start();
		this.logger.info("http server started", { host: address.host, port: address.port });
	}

	private async startupTerminalWorkspaceCleanup(): Promise<void> {
		try {
			const issues = await this.tracker.fetchIssuesByStates(this.requireConfig().tracker.terminalStates);
			for (const issue of issues) await this.workspace.removeForIssue(issue.identifier, undefined, { issue_id: issue.id, issue_identifier: issue.identifier });
			this.logger.info("startup terminal cleanup completed", { count: issues.length });
		} catch (error) {
			this.logger.warn("startup terminal cleanup failed", { error: errorMessage(error) });
		}
	}

	private async reconcileRunningIssues(): Promise<void> {
		this.reconcileStalledRuns();
		const runningIds = [...this.state.running.keys()];
		if (runningIds.length === 0) return;
		let refreshed: Issue[];
		try {
			refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
		} catch (error) {
			this.logger.warn("state refresh failed; keeping workers running", { error: errorMessage(error) });
			return;
		}
		const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
		for (const id of runningIds) {
			const current = byId.get(id);
			if (!current) continue;
			const entry = this.state.running.get(id);
			if (!entry) continue;
			if (this.isTerminalState(current.state)) {
				entry.abort_reason = "cancelled_by_reconciliation";
				entry.terminal_reason = "cancelled_by_reconciliation";
				entry.abort.abort();
				await this.finishRunArtifact(entry, "cancelled", "cancelled_by_reconciliation", new Error("cancelled_by_reconciliation"));
				this.releaseIssue(id);
				await this.workspace.removeForIssue(entry.identifier, undefined, issueContext(entry));
				this.logger.info("terminal issue stopped and workspace cleaned", { issue_id: id, issue_identifier: entry.identifier, terminal_reason: "cancelled_by_reconciliation" });
			} else if (this.isActiveState(current.state)) {
				entry.issue = current;
			} else {
				entry.abort_reason = "cancelled_by_reconciliation";
				entry.terminal_reason = "cancelled_by_reconciliation";
				entry.abort.abort();
				await this.finishRunArtifact(entry, "cancelled", "cancelled_by_reconciliation", new Error("cancelled_by_reconciliation"));
				this.releaseIssue(id);
				this.logger.info("non-active issue stopped", { issue_id: id, issue_identifier: entry.identifier, state: current.state, terminal_reason: "cancelled_by_reconciliation" });
			}
		}
	}

	private reconcileStalledRuns(): void {
		const config = this.requireConfig();
		const stallTimeout = config.runner.kind === "pi" ? config.pi.stallTimeoutMs : config.codex.stallTimeoutMs;
		if (stallTimeout <= 0) return;
		const now = Date.now();
		for (const [id, entry] of this.state.running.entries()) {
			const since = entry.last_codex_timestamp ? Date.parse(entry.last_codex_timestamp) : Date.parse(entry.started_at);
			if (now - since > stallTimeout) {
				entry.abort_reason = "stalled";
				entry.terminal_reason = "stalled";
				entry.abort.abort();
				this.logger.warn("stalled run aborted", { issue_id: id, issue_identifier: entry.identifier, terminal_reason: "stalled" });
			}
		}
	}

	private async dispatchAndWait(issue: Issue, attempt: number | null): Promise<RunOnceResult> {
		const entry = this.dispatch(issue, attempt);
		await entry.promise;
		return {
			issueIdentifier: entry.identifier,
			workspacePath: entry.workspace_path,
			artifactPath: entry.artifact_path,
		};
	}

	private dispatch(issue: Issue, attempt: number | null): RunningEntry {
		if (this.state.claimed.has(issue.id) || this.state.running.has(issue.id)) throw new Error(`Issue already claimed: ${issue.identifier}`);
		const abort = new AbortController();
		const entry: RunningEntry = {
			issue,
			identifier: issue.identifier,
			started_at: new Date().toISOString(),
			workspace_path: null,
			artifact_path: null,
			retry_attempt: attempt,
			abort,
			abort_reason: null,
			promise: Promise.resolve(),
			last_error: null,
			terminal_reason: null,
			session_id: null,
			thread_id: null,
			turn_id: null,
			codex_app_server_pid: null,
			last_codex_event: null,
			last_codex_timestamp: null,
			last_codex_message: null,
			codex_input_tokens: 0,
			codex_output_tokens: 0,
			codex_total_tokens: 0,
			last_reported_input_tokens: 0,
			last_reported_output_tokens: 0,
			last_reported_total_tokens: 0,
			turn_count: 0,
			recent_events: [],
			recent_agent_messages: [],
			current_agent_message: null,
			current_agent_message_at: null,
		};
		this.observeQueueIssue(issue, "dispatched");
		this.state.claimed.add(issue.id);
		const oldRetry = this.state.retry_attempts.get(issue.id);
		if (oldRetry) clearTimeout(oldRetry.timer_handle);
		this.state.retry_attempts.delete(issue.id);
		this.state.running.set(issue.id, entry);
		entry.promise = this.runAgentAttempt(entry).then(
			() => this.onWorkerExit(issue.id, "normal"),
			(error) => {
				entry.last_error = errorMessage(error);
				return this.onWorkerExit(issue.id, "abnormal", error);
			},
		);
		this.logger.info("issue dispatched", { issue_id: issue.id, issue_identifier: issue.identifier, attempt });
		return entry;
	}

	private async runAgentAttempt(entry: RunningEntry): Promise<void> {
		const workflow = this.requireWorkflow();
		const config = this.requireConfig();
		const context = issueContext(entry);
		const workspace = await this.workspace.createForIssue(entry.identifier, entry.abort.signal, context);
		entry.workspace_path = workspace.path;
		try {
			const prompt = await renderPromptTemplate(workflow.prompt_template, entry.issue, entry.retry_attempt);
			await this.prepareRunArtifacts(entry, workspace.path, prompt);
			await this.workspace.runBeforeRun(workspace.path, entry.abort.signal, context);
			const continuationCount = Math.max(config.agent.maxTurns - 1, 0);
			const continuationPrompts = Array.from({ length: continuationCount }, () => CONTINUATION_PROMPT);
			const client = config.runner.kind === "pi" ? new PiAppServerClient(config, this.logger) : new CodexAppServerClient(config, this.logger);
			await client.runWorker({
				workspacePath: workspace.path,
				issue: entry.issue,
				prompt,
				continuationPrompts,
				signal: entry.abort.signal,
				onEvent: (event) => this.onCodexEvent(entry.issue.id, event),
				onAfterTurn: async () => {
					const [fresh] = await this.tracker.fetchIssueStatesByIds([entry.issue.id], entry.abort.signal);
					if (fresh) {
						entry.issue = fresh;
						this.observeQueueIssue(fresh, "observed_refresh");
					}
					return Boolean(fresh && this.isActiveState(fresh.state));
				},
			});
		} finally {
			await this.workspace.runAfterRun(workspace.path, entry.abort.signal, context);
		}
	}

	private async onWorkerExit(issueId: string, reason: "normal" | "abnormal", error?: unknown): Promise<void> {
		const entry = this.state.running.get(issueId);
		if (!entry) return;
		this.state.running.delete(issueId);
		this.state.codex_totals.seconds_running += (Date.now() - Date.parse(entry.started_at)) / 1000;
		if (reason === "normal") {
			entry.terminal_reason = "succeeded";
			await this.finishRunArtifact(entry, "succeeded", "succeeded");
			this.state.completed.add(issueId);
			this.scheduleRetry(issueId, entry.identifier, 1, "continuation", 1_000, entry.artifact_path, "succeeded");
		} else if (entry.abort.signal.aborted) {
			const terminalReason = entry.abort_reason ?? classifyTerminalReason(error, true);
			entry.terminal_reason = terminalReason;
			await this.finishRunArtifact(entry, "cancelled", terminalReason, error);
			this.scheduleRetry(issueId, entry.identifier, nextAttempt(entry.retry_attempt), terminalReason === "stalled" ? "worker stalled" : "worker aborted", undefined, entry.artifact_path, terminalReason);
		} else {
			const terminalReason = classifyTerminalReason(error, false);
			entry.terminal_reason = terminalReason;
			await this.finishRunArtifact(entry, "failed", terminalReason, error);
			this.scheduleRetry(issueId, entry.identifier, nextAttempt(entry.retry_attempt), errorMessage(error), undefined, entry.artifact_path, terminalReason);
		}
		await this.reloadQueueAfterWorkerExit(entry);
	}

	private scheduleRetry(issueId: string, identifier: string, attempt: number, error: string | null, explicitDelayMs?: number, artifactPath?: string | null, terminalReason?: RunTerminalReason | null): void {
		if (this.stopping) return;
		const existing = this.state.retry_attempts.get(issueId);
		if (existing) clearTimeout(existing.timer_handle);
		const delay = explicitDelayMs ?? Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.requireConfig().agent.maxRetryBackoffMs);
		const timer = setTimeout(() => void this.onRetryTimer(issueId), delay);
		const retry = { issue_id: issueId, identifier, attempt, due_at_ms: performance.now() + delay, timer_handle: timer, error, artifact_path: artifactPath ?? null, terminal_reason: terminalReason ?? null };
		this.state.retry_attempts.set(issueId, retry);
		this.state.claimed.add(issueId);
		this.logger.info("retry scheduled", { issue_id: issueId, issue_identifier: identifier, attempt, delay_ms: delay, error, terminal_reason: terminalReason ?? null });
	}

	private async onRetryTimer(issueId: string): Promise<void> {
		const retry = this.state.retry_attempts.get(issueId);
		if (!retry) return;
		this.state.retry_attempts.delete(issueId);
		let candidates: Issue[];
		try {
			candidates = await this.tracker.fetchCandidateIssues();
		} catch {
			this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, "retry poll failed");
			return;
		}
		for (const candidate of candidates) this.observeQueueIssue(candidate, "candidate");
		const issue = candidates.find((candidate) => candidate.id === issueId);
		if (!issue) {
			this.releaseIssue(issueId);
			return;
		}
		if (!this.hasSlotsFor(issue)) {
			this.scheduleRetry(issueId, issue.identifier, retry.attempt + 1, "no available orchestrator slots");
			return;
		}
		this.state.claimed.delete(issueId);
		if (this.shouldDispatch(issue)) this.dispatch(issue, retry.attempt);
		else this.releaseIssue(issueId);
	}

	private onCodexEvent(issueId: string, event: CodexRuntimeEvent): void {
		const entry = this.state.running.get(issueId);
		if (!entry) return;
		entry.session_id = event.session_id ?? entry.session_id;
		entry.thread_id = event.thread_id ?? entry.thread_id;
		entry.turn_id = event.turn_id ?? entry.turn_id;
		entry.codex_app_server_pid = event.codex_app_server_pid ?? entry.codex_app_server_pid;
		const agentTextEvent = isAgentTextEvent(event);
		entry.last_codex_event = agentTextEvent ? "agent_message" : event.event;
		entry.last_codex_timestamp = event.timestamp;
		entry.last_codex_message = event.message ?? null;
		this.recordAgentMessage(entry, event);
		if (!agentTextEvent) {
			entry.recent_events.push({ at: event.timestamp, event: event.event, message: event.message ?? null });
			if (entry.recent_events.length > RECENT_EVENT_LIMIT) entry.recent_events.splice(0, entry.recent_events.length - RECENT_EVENT_LIMIT);
		}
		if (event.event === "session_started") {
			entry.turn_count += 1;
			this.logger.info("codex session started", { issue_id: issueId, issue_identifier: entry.identifier, session_id: event.session_id ?? null, thread_id: event.thread_id ?? null, turn_id: event.turn_id ?? null });
		}
		if (event.event === "turn_completed" || event.event === "turn_failed" || event.event === "turn_cancelled" || event.event === "turn_input_required" || event.event === "approval_auto_approved") {
			this.logger.info("codex event", { issue_id: issueId, issue_identifier: entry.identifier, session_id: event.session_id ?? entry.session_id, thread_id: event.thread_id ?? entry.thread_id, turn_id: event.turn_id ?? entry.turn_id, event: event.event });
		}
		if (event.rate_limits) this.state.codex_rate_limits = event.rate_limits;
		if (entry.artifact_path) {
			try {
				appendFileSync(join(entry.artifact_path, "events.jsonl"), `${redactedJson(event, this.secretValues())}\n`, "utf8");
			} catch (error) {
				this.logger.warn("run artifact event write failed", { issue_id: issueId, issue_identifier: entry.identifier, session_id: entry.session_id, error: errorMessage(error) });
			}
		}
		this.applyUsage(entry, event.usage);
	}

	private recordAgentMessage(entry: RunningEntry, event: CodexRuntimeEvent): void {
		const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, any>) : null;
		if (event.event === "item_agentMessage_delta") {
			const delta = typeof payload?.delta === "string" ? payload.delta : event.message ?? "";
			if (!delta) return;
			if (entry.current_agent_message === null) {
				entry.current_agent_message = "";
				entry.current_agent_message_at = event.timestamp;
			}
			entry.current_agent_message = trimAgentMessage(entry.current_agent_message + delta);
			this.upsertStreamingAgentMessage(entry, event.timestamp);
			return;
		}

		const item = payload?.item && typeof payload.item === "object" ? (payload.item as Record<string, any>) : null;
		if (event.event === "item_completed" && item?.type === "agentMessage") {
			const text = trimAgentMessage(typeof item.text === "string" ? item.text : entry.current_agent_message ?? event.message ?? "");
			if (text.trim()) {
				const last = entry.recent_agent_messages[entry.recent_agent_messages.length - 1];
				const completed = { at: event.timestamp, text, streaming: false };
				if (last?.streaming) entry.recent_agent_messages[entry.recent_agent_messages.length - 1] = completed;
				else entry.recent_agent_messages.push(completed);
				trimRecentAgentMessages(entry);
			}
			entry.current_agent_message = null;
			entry.current_agent_message_at = null;
		}
	}

	private upsertStreamingAgentMessage(entry: RunningEntry, timestamp: string): void {
		const text = trimAgentMessage(entry.current_agent_message ?? "");
		if (!text.trim()) return;
		const last = entry.recent_agent_messages[entry.recent_agent_messages.length - 1];
		if (last?.streaming) {
			last.at = timestamp;
			last.text = text;
		} else {
			entry.recent_agent_messages.push({ at: entry.current_agent_message_at ?? timestamp, text, streaming: true });
			trimRecentAgentMessages(entry);
		}
	}

	private async prepareRunArtifacts(entry: RunningEntry, workspacePath: string, prompt: string): Promise<void> {
		const dir = this.runArtifactDir(entry);
		entry.artifact_path = dir;
		await mkdir(dir, { recursive: true });
		const secrets = this.secretValues();
		await writeFile(join(dir, "prompt.md"), redactText(prompt, secrets), "utf8");
		await writeFile(join(dir, "events.jsonl"), "", "utf8");
		await writeFile(
			join(dir, "metadata.json"),
			redactedJson(
				{
					issue_id: entry.issue.id,
					issue_identifier: entry.identifier,
					attempt: entry.retry_attempt ?? 0,
					started_at: entry.started_at,
					workspace_path: workspacePath,
					workflow_path: this.requireConfig().workflowPath,
					runner_kind: this.requireConfig().runner.kind,
				},
				secrets,
			),
			"utf8",
		);
	}

	private async finishRunArtifact(entry: RunningEntry, status: RunStatus, terminalReason: RunTerminalReason, error?: unknown): Promise<void> {
		if (!entry.artifact_path) return;
		await writeFile(
			join(entry.artifact_path, "result.json"),
			redactedJson(
				{
					status,
					terminal_reason: terminalReason,
					finished_at: new Date().toISOString(),
					issue_id: entry.issue.id,
					issue_identifier: entry.identifier,
					workspace_path: entry.workspace_path,
					last_event: entry.last_codex_event,
					last_error: error ? errorMessage(error) : entry.last_error,
				},
				this.secretValues(),
			),
			"utf8",
		);
	}

	private runArtifactDir(entry: RunningEntry): string {
		const safeTime = entry.started_at.replace(/[^0-9A-Za-z.-]/g, "_");
		const safeIdentifier = this.workspace.sanitizeIdentifier(entry.identifier);
		const attempt = entry.retry_attempt ?? 0;
		return join(this.requireConfig().workflowDir, ".symphony", "runs", `${safeTime}_${safeIdentifier}_attempt-${attempt}`);
	}

	private secretValues(): string[] {
		const config = this.requireConfig();
		return [config.tracker.apiKey, config.tracker.jiraApiToken].filter((value): value is string => Boolean(value));
	}

	private applyUsage(entry: RunningEntry, usage: unknown): void {
		const counts = extractAbsoluteUsage(usage);
		if (!counts) return;
		const inputDelta = Math.max(counts.input - entry.last_reported_input_tokens, 0);
		const outputDelta = Math.max(counts.output - entry.last_reported_output_tokens, 0);
		const totalDelta = Math.max(counts.total - entry.last_reported_total_tokens, 0);
		entry.codex_input_tokens = counts.input;
		entry.codex_output_tokens = counts.output;
		entry.codex_total_tokens = counts.total;
		entry.last_reported_input_tokens = counts.input;
		entry.last_reported_output_tokens = counts.output;
		entry.last_reported_total_tokens = counts.total;
		this.state.codex_totals.input_tokens += inputDelta;
		this.state.codex_totals.output_tokens += outputDelta;
		this.state.codex_totals.total_tokens += totalDelta;
	}

	private sortForDispatch(issues: Issue[]): Issue[] {
		return sortIssuesForDispatch(issues);
	}

	private shouldDispatch(issue: Issue): boolean {
		return evaluateIssueEligibility(issue, runtimeStateFromOrchestratorState(this.state), this.requireConfig()).eligible;
	}

	private hasSlotsFor(issue: Issue): boolean {
		const result = evaluateIssueEligibility(issue, runtimeStateFromOrchestratorState(this.state), this.requireConfig());
		return !result.reasons.some((reason) => reason.code === "no_global_slots" || reason.code === "state_limit_reached");
	}

	private availableGlobalSlots(): number {
		return Math.max(this.requireConfig().agent.maxConcurrentAgents - this.state.running.size, 0);
	}

	private isActiveState(state: string): boolean {
		const normalized = normalizeState(state);
		return this.requireConfig().tracker.activeStates.map(normalizeState).includes(normalized);
	}

	private isTerminalState(state: string): boolean {
		const normalized = normalizeState(state);
		return this.requireConfig().tracker.terminalStates.map(normalizeState).includes(normalized);
	}

	private releaseIssue(issueId: string): void {
		const retry = this.state.retry_attempts.get(issueId);
		if (retry) clearTimeout(retry.timer_handle);
		this.state.retry_attempts.delete(issueId);
		this.state.claimed.delete(issueId);
		this.state.running.delete(issueId);
	}

	private observeQueueIssue(issue: Issue, reason: ObservedQueueIssue["reason"]): void {
		const existing = this.observedQueueIssues.get(issue.id);
		const lastSeenAtMs = reason === "observed_refresh" && existing ? existing.last_seen_at_ms : Date.now();
		this.observedQueueIssues.set(issue.id, { issue, last_seen_at_ms: lastSeenAtMs, reason });
		this.pruneObservedQueueIssues();
	}

	private async refreshObservedQueueIssues(activeIds = new Set<string>()): Promise<void> {
		this.pruneObservedQueueIssues();
		const ids = [...this.observedQueueIssues.keys()].filter((id) => !activeIds.has(id)).slice(0, OBSERVED_QUEUE_LIMIT);
		if (ids.length === 0) return;
		try {
			const refreshed = await this.tracker.fetchIssueStatesByIds(ids);
			for (const issue of refreshed) this.observeQueueIssue(issue, "observed_refresh");
		} catch (error) {
			this.logger.warn("observed queue refresh failed; keeping cached tracker state", { error: errorMessage(error) });
		}
	}

	private async reloadQueueAfterWorkerExit(entry: RunningEntry): Promise<void> {
		this.observeQueueIssue(entry.issue, "worker_exit");
		try {
			const candidates = await this.tracker.fetchCandidateIssues();
			for (const issue of candidates) this.observeQueueIssue(issue, "candidate");
		} catch (error) {
			this.logger.warn("worker-exit queue reload failed", { issue_id: entry.issue.id, issue_identifier: entry.identifier, error: errorMessage(error) });
		}
		try {
			const [fresh] = await this.tracker.fetchIssueStatesByIds([entry.issue.id]);
			if (fresh) {
				entry.issue = fresh;
				this.observeQueueIssue(fresh, "worker_exit");
			}
		} catch (error) {
			this.logger.warn("worker-exit issue state refresh failed", { issue_id: entry.issue.id, issue_identifier: entry.identifier, error: errorMessage(error) });
		}
	}

	private pruneObservedQueueIssues(now = Date.now()): void {
		const protectedIds = new Set([...this.state.running.keys(), ...this.state.retry_attempts.keys()]);
		for (const [id, entry] of this.observedQueueIssues.entries()) {
			if (!protectedIds.has(id) && now - entry.last_seen_at_ms > OBSERVED_QUEUE_TTL_MS) this.observedQueueIssues.delete(id);
		}
		if (this.observedQueueIssues.size <= OBSERVED_QUEUE_LIMIT) return;
		const pruneable = [...this.observedQueueIssues.entries()].filter(([id]) => !protectedIds.has(id)).sort((a, b) => a[1].last_seen_at_ms - b[1].last_seen_at_ms);
		for (const [id] of pruneable) {
			if (this.observedQueueIssues.size <= OBSERVED_QUEUE_LIMIT) break;
			this.observedQueueIssues.delete(id);
		}
	}

	private requireConfig(): SymphonyConfig {
		if (!this.config) throw new Error("Symphony config not loaded");
		return this.config;
	}

	private requireWorkflow(): WorkflowDefinition {
		if (!this.workflow) throw new Error("Symphony workflow not loaded");
		return this.workflow;
	}
}

function issueContext(entry: RunningEntry): { issue_id: string; issue_identifier: string } {
	return { issue_id: entry.issue.id, issue_identifier: entry.identifier };
}

function trimRecentAgentMessages(entry: RunningEntry): void {
	if (entry.recent_agent_messages.length > RECENT_AGENT_MESSAGE_LIMIT) entry.recent_agent_messages.splice(0, entry.recent_agent_messages.length - RECENT_AGENT_MESSAGE_LIMIT);
}

function isAgentTextEvent(event: CodexRuntimeEvent): boolean {
	const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, any>) : null;
	const item = payload?.item && typeof payload.item === "object" ? (payload.item as Record<string, any>) : null;
	return event.event === "item_agentMessage_delta" || (event.event === "item_completed" && item?.type === "agentMessage");
}

function trimAgentMessage(text: string): string {
	return text.length <= MAX_AGENT_MESSAGE_CHARS ? text : `…${text.slice(text.length - MAX_AGENT_MESSAGE_CHARS)}`;
}

function runningRow(entry: RunningEntry): Record<string, unknown> {
	return {
		issue_id: entry.issue.id,
		issue_identifier: entry.identifier,
		state: entry.issue.state,
		pid: entry.codex_app_server_pid,
		session_id: entry.session_id,
		terminal_reason: entry.terminal_reason,
		turn_count: entry.turn_count,
		last_event: entry.last_codex_event,
		last_message: entry.last_codex_message,
		started_at: entry.started_at,
		last_event_at: entry.last_codex_timestamp,
		artifact_path: entry.artifact_path,
		artifacts: entry.artifact_path ? artifactPaths(entry.artifact_path) : null,
		logs: entry.artifact_path ? artifactLogs(entry.artifact_path) : { codex_session_logs: [] },
		recent_events: entry.recent_events,
		recent_agent_messages: entry.recent_agent_messages,
		tokens: {
			input_tokens: entry.codex_input_tokens,
			output_tokens: entry.codex_output_tokens,
			total_tokens: entry.codex_total_tokens,
		},
	};
}

function extractAbsoluteUsage(usage: unknown): { input: number; output: number; total: number } | null {
	if (!usage || typeof usage !== "object") return null;
	const root = usage as Record<string, unknown>;
	const source = objectAt(root, "total_token_usage") ?? objectAt(root, "totalTokenUsage") ?? root;
	const input = numberAt(source, ["input_tokens", "inputTokens", "input"]);
	const output = numberAt(source, ["output_tokens", "outputTokens", "output"]);
	const total = numberAt(source, ["total_tokens", "totalTokens", "total"]);
	if (input === null && output === null && total === null) return null;
	return { input: input ?? 0, output: output ?? 0, total: total ?? (input ?? 0) + (output ?? 0) };
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = root[key];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberAt(root: Record<string, unknown>, keys: string[]): number | null {
	for (const key of keys) {
		const value = root[key];
		if (typeof value === "number") return value;
	}
	return null;
}

function nextAttempt(attempt: number | null): number {
	return attempt === null ? 1 : attempt + 1;
}

function artifactPaths(dir: string): Record<string, string> {
	return {
		dir,
		prompt: join(dir, "prompt.md"),
		events: join(dir, "events.jsonl"),
		metadata: join(dir, "metadata.json"),
		result: join(dir, "result.json"),
	};
}

function artifactLogs(dir: string): { codex_session_logs: Array<{ label: string; path: string; url: string }> } {
	const events = join(dir, "events.jsonl");
	return { codex_session_logs: [{ label: "Codex events", path: events, url: `file://${events}` }] };
}

function classifyTerminalReason(error: unknown, aborted: boolean): RunTerminalReason {
	const message = errorMessage(error);
	if (/turn_timeout|response_timeout|timeout/i.test(message)) return "timed_out";
	if (/turn_input_required/i.test(message)) return "user_input_required";
	if (aborted) return "cancelled";
	return "failed";
}

function redactedJson(value: unknown, secrets: string[]): string {
	return `${redactText(JSON.stringify(value, null, 2), secrets)}\n`;
}

function redactText(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 4) out = out.split(secret).join("[redacted]");
	}
	return out
		.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*)=([^\s\"]+)/gi, "$1=[redacted]")
		.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
