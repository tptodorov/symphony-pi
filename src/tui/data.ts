import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadResolvedConfig, probeConfig, resolveWorkflowPath, validateDispatchConfig } from "../config.js";
import { createFileLogger } from "../logger.js";
import { SymphonyOrchestrator, type QueueSnapshot, type RunOnceResult } from "../orchestrator.js";
import { createTrackerAdapter } from "../tracker.js";
import type { Issue, Logger, SymphonyConfig } from "../types.js";
import { evaluateIssueEligibility, sortIssuesForDispatch } from "../eligibility.js";

const QUEUE_CACHE_TTL_MS = 5_000;

export interface SymphonyArgs {
	workflowPath?: string;
	port?: number;
	argError?: string;
}

export interface OnceRunState {
	selector?: string;
	startedAt: string;
	result?: RunOnceResult;
	error?: string;
}

export interface SymphonyRuntimeState {
	daemon: SymphonyOrchestrator | null;
	daemonStartedAt: number | null;
	onceRun: OnceRunState | null;
}

export interface SymphonyControls {
	cwd: string;
	getRuntime(): SymphonyRuntimeState;
	startDaemon(args: SymphonyArgs): Promise<void>;
	stopDaemon(): Promise<void>;
	runOnce(selector: string | undefined, args: SymphonyArgs): Promise<RunOnceResult>;
	openExternal(target: string): Promise<void>;
	setFooterStatus(value: string | undefined): void;
}

export interface ConfigSnapshot {
	workflowPath: string;
	valid: boolean;
	loadedAt: string;
	config: SymphonyConfig | null;
	error: { code: string; message: string } | null;
}

export interface TrackerIssueDetail {
	issue: Issue;
	fetchedAt: string;
	source: "tracker";
}

export interface RunArtifactSummary {
	name: string;
	path: string;
	mtimeMs: number;
	status: string;
	terminalReason: string;
	issueIdentifier: string;
	workspacePath: string | null;
	finishedAt: string | null;
	lastEvent: string | null;
	errorSummary: string | null;
	result: Record<string, unknown> | null;
	logs: string[];
	timeline: RunTimelineItem[];
}

export interface RunTimelineItem {
	label: string;
	at: string | null;
	note: string | null;
	tone: "normal" | "success" | "warning" | "error";
}

export function parseSymphonyArgs(args: string): SymphonyArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let port: number | undefined;
	let workflowPath: string | undefined;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part === "--port") {
			const value = parts[++i];
			if (!value || !/^\d+$/.test(value)) return { workflowPath, port, argError: "--port requires a numeric value" };
			port = Number(value);
		} else if (part.startsWith("--port=")) {
			const value = part.slice("--port=".length);
			if (!/^\d+$/.test(value)) return { workflowPath, port, argError: "--port requires a numeric value" };
			port = Number(value);
		} else if (part === "--workflow") {
			const value = parts[++i];
			if (!value) return { workflowPath, port, argError: "--workflow requires a path" };
			workflowPath = value;
		} else if (part.startsWith("--")) {
			return { workflowPath, port, argError: `Unknown option: ${part}` };
		} else if (!workflowPath) {
			workflowPath = part;
		} else {
			return { workflowPath, port, argError: `Unexpected argument: ${part}` };
		}
	}
	return { ...(workflowPath !== undefined ? { workflowPath } : {}), ...(port !== undefined ? { port } : {}) };
}

export function symphonyLogPath(cwd: string, workflowPath?: string): string {
	return join(dirname(resolveWorkflowPath(cwd, workflowPath)), ".symphony", "logs", "symphony.log");
}

export class SymphonyConsoleDataProvider {
	private cachedQueue: QueueSnapshot | null = null;
	private cachedConfig: ConfigSnapshot | null = null;

	constructor(
		private readonly controls: SymphonyControls,
		private readonly args: SymphonyArgs,
		private readonly logger: Logger = createFileLogger(symphonyLogPath(controls.cwd, args.workflowPath)),
	) {}

	get runtime(): SymphonyRuntimeState {
		return this.controls.getRuntime();
	}

	get logPath(): string {
		return symphonyLogPath(this.controls.cwd, this.args.workflowPath);
	}

	get requestedWorkflowPath(): string {
		return resolveWorkflowPath(this.controls.cwd, this.args.workflowPath);
	}

	workflowMismatch(): string | null {
		const running = this.runtime.daemon?.getWorkflowPath();
		if (!running) return null;
		return running === this.requestedWorkflowPath ? null : `Daemon running for ${running}; requested ${this.requestedWorkflowPath}. Stop daemon before switching.`;
	}

	async configSnapshot(force = false): Promise<ConfigSnapshot> {
		if (this.args.argError) {
			return { workflowPath: this.requestedWorkflowPath, valid: false, loadedAt: new Date().toISOString(), config: null, error: { code: "invalid_args", message: this.args.argError } };
		}
		if (!force && this.cachedConfig) return this.cachedConfig;
		const probe = await probeConfig(this.controls.cwd, this.args.workflowPath);
		if (!probe.valid) {
			this.cachedConfig = { workflowPath: probe.workflowPath, valid: false, loadedAt: new Date().toISOString(), config: null, error: probe.error ? { code: probe.error.code, message: probe.error.message } : { code: "invalid_config", message: "Workflow is invalid" } };
			return this.cachedConfig;
		}
		try {
			const { config } = await loadResolvedConfig(this.controls.cwd, this.args.workflowPath);
			validateDispatchConfig(config);
			this.cachedConfig = { workflowPath: config.workflowPath, valid: true, loadedAt: new Date().toISOString(), config, error: null };
			return this.cachedConfig;
		} catch (error) {
			this.cachedConfig = { workflowPath: probe.workflowPath, valid: false, loadedAt: new Date().toISOString(), config: null, error: normalizeError(error) };
			return this.cachedConfig;
		}
	}

	async queueSnapshot(force = false): Promise<QueueSnapshot> {
		if (!force && this.cachedQueue && isFreshQueueSnapshot(this.cachedQueue)) return this.cachedQueue;
		const daemon = this.runtime.daemon;
		if (daemon) {
			this.cachedQueue = await daemon.queueSnapshot();
			return this.cachedQueue;
		}
		try {
			const cfg = await this.configSnapshot(force);
			if (!cfg.valid || !cfg.config) throw new Error(cfg.error?.message ?? "Config invalid");
			const tracker = createTrackerAdapter(() => cfg.config!, this.logger);
			const issues = sortIssuesForDispatch(await tracker.fetchCandidateIssues());
			const runtime = { running: [], runningIds: new Set<string>(), claimedIds: new Set<string>(), completedIds: new Set<string>(), retryingIds: new Set<string>() };
			const rows = issues.map((issue) => ({ issue, eligibility: evaluateIssueEligibility(issue, runtime, cfg.config!) }));
			this.cachedQueue = { eligible: rows.filter((row) => row.eligibility.eligible), notDispatchable: rows.filter((row) => !row.eligibility.eligible), recentlyChanged: [], retrying: [], fetched_at: new Date().toISOString(), error: null };
		} catch (error) {
			this.cachedQueue = { eligible: [], notDispatchable: [], recentlyChanged: [], retrying: [], fetched_at: new Date().toISOString(), error: errorMessage(error) };
		}
		return this.cachedQueue;
	}

	async refreshIssueDetails(issue: Issue): Promise<TrackerIssueDetail> {
		const daemon = this.runtime.daemon;
		const fresh = daemon ? await daemon.refreshIssueDetails(issue) : await this.fetchIssueDetailsWithoutDaemon(issue);
		return { issue: fresh ?? issue, fetchedAt: new Date().toISOString(), source: "tracker" };
	}

	async logTail(path = this.logPath, maxLines = 800): Promise<string[]> {
		try {
			const text = await readFile(path, "utf8");
			return text.split(/\r?\n/).slice(-maxLines);
		} catch (error) {
			return [`Log unavailable: ${errorMessage(error)}`, path];
		}
	}

	private async fetchIssueDetailsWithoutDaemon(issue: Issue): Promise<Issue | null> {
		const cfg = await this.configSnapshot(false);
		if (!cfg.valid || !cfg.config) throw new Error(cfg.error?.message ?? "Config invalid");
		const tracker = createTrackerAdapter(() => cfg.config!, this.logger);
		const [fresh] = await tracker.fetchIssueStatesByIds([issue.id]);
		return fresh ?? null;
	}

	async exportRunDebugBundle(run: RunArtifactSummary): Promise<string> {
		const config = await this.configSnapshot(false).catch(() => null);
		const [metadata, eventsText] = await Promise.all([
			readOptionalText(join(run.path, "metadata.json")),
			readOptionalText(run.logs[0] ?? join(run.path, "events.jsonl")),
		]);
		const bundle = {
			exported_at: new Date().toISOString(),
			run: {
				name: run.name,
				path: run.path,
				status: run.status,
				terminal_reason: run.terminalReason,
				issue_identifier: run.issueIdentifier,
				workspace_path: run.workspacePath,
				finished_at: run.finishedAt,
				error_summary: run.errorSummary,
				last_event: run.lastEvent,
			},
			config: config?.config
				? {
						workflow_path: config.config.workflowPath,
						tracker_kind: config.config.tracker.kind,
						active_states: config.config.tracker.activeStates,
						terminal_states: config.config.tracker.terminalStates,
						max_concurrent_agents: config.config.agent.maxConcurrentAgents,
						max_concurrent_agents_by_state: config.config.agent.maxConcurrentAgentsByState,
						codex_turn_timeout_ms: config.config.codex.turnTimeoutMs,
						codex_stall_timeout_ms: config.config.codex.stallTimeoutMs,
					}
				: null,
			metadata: parseJsonObject(metadata),
			result: run.result,
			log_excerpt: redactBundleText(eventsText.split(/\r?\n/).filter(Boolean).slice(-120).join("\n")),
		};
		const outputPath = join(run.path, "debug-bundle.json");
		await writeFile(outputPath, `${redactBundleText(JSON.stringify(bundle, null, 2))}\n`, "utf8");
		return outputPath;
	}

	async recentRuns(limit = 50): Promise<RunArtifactSummary[]> {
		const config = await this.configSnapshot(false).catch(() => null);
		const workflowDir = config?.config?.workflowDir ?? dirname(this.requestedWorkflowPath);
		const runsDir = join(workflowDir, ".symphony", "runs");
		try {
			const entries = await readdir(runsDir);
			const rows = await Promise.all(entries.map((entry) => this.readRunSummary(runsDir, entry)));
			return rows.filter((row): row is RunArtifactSummary => Boolean(row)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
		} catch {
			return [];
		}
	}

	private async readRunSummary(runsDir: string, entry: string): Promise<RunArtifactSummary | null> {
		const path = join(runsDir, entry);
		try {
			const stats = await stat(path);
			if (!stats.isDirectory()) return null;
			let result: Record<string, unknown> | null = null;
			let metadata: Record<string, unknown> | null = null;
			let events: Record<string, unknown>[] = [];
			try {
				result = JSON.parse(await readFile(join(path, "result.json"), "utf8")) as Record<string, unknown>;
			} catch {}
			try {
				metadata = JSON.parse(await readFile(join(path, "metadata.json"), "utf8")) as Record<string, unknown>;
			} catch {}
			try {
				events = parseJsonLines(await readFile(join(path, "events.jsonl"), "utf8"));
			} catch {}
			const workspacePath = stringValue(result?.workspace_path) || stringValue(metadata?.workspace_path) || null;
			return {
				name: entry,
				path,
				mtimeMs: stats.mtimeMs,
				status: stringValue(result?.status) || (result ? "finished" : "in_progress"),
				terminalReason: stringValue(result?.terminal_reason),
				issueIdentifier: stringValue(result?.issue_identifier) || stringValue(metadata?.issue_identifier) || entry.split("-").slice(0, 2).join("-") || entry,
				workspacePath,
				finishedAt: stringValue(result?.finished_at) || null,
				lastEvent: summarizeValue(result?.last_event),
				errorSummary: stringValue(result?.last_error) || null,
				result,
				logs: [join(path, "events.jsonl")],
				timeline: buildRunTimeline(metadata, events, result, workspacePath),
			};
		} catch {
			return null;
		}
	}
}

async function readOptionalText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

function parseJsonObject(text: string): unknown {
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function parseJsonLines(text: string): Record<string, unknown>[] {
	const rows: Record<string, unknown>[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows.push(parsed as Record<string, unknown>);
		} catch {}
	}
	return rows;
}

function buildRunTimeline(metadata: Record<string, unknown> | null, events: Record<string, unknown>[], result: Record<string, unknown> | null, workspacePath: string | null): RunTimelineItem[] {
	const out: RunTimelineItem[] = [];
	const startedAt = stringValue(metadata?.started_at);
	if (startedAt) out.push({ label: "claimed", at: startedAt, note: stringValue(metadata?.issue_identifier) || null, tone: "normal" });
	if (workspacePath) out.push({ label: "workspace", at: startedAt || null, note: workspacePath, tone: "normal" });
	for (const event of events.slice(-40)) {
		const label = stringValue(event.event);
		if (!label) continue;
		const tone = /failed|error|cancelled/i.test(label) ? "error" : /timeout|input_required|approval/i.test(label) ? "warning" : "normal";
		const noteRaw = stringValue(event.message) || stringValue(event.session_id) || stringValue(event.turn_id) || null;
		const note = noteRaw ? redactBundleText(noteRaw) : null;
		out.push({ label, at: stringValue(event.timestamp) || null, note, tone });
	}
	if (result) {
		const status = stringValue(result.status) || "finished";
		const terminal = stringValue(result.terminal_reason);
		const tone = status === "succeeded" ? "success" : status === "cancelled" || terminal === "stalled" || /timeout|input/i.test(terminal) ? "warning" : status === "failed" ? "error" : "normal";
		out.push({ label: `result:${status}`, at: stringValue(result.finished_at) || null, note: terminal || stringValue(result.last_error) || null, tone });
	}
	return out.sort((a, b) => timestampSort(a.at) - timestampSort(b.at));
}

function timestampSort(value: string | null): number {
	if (!value) return Number.MAX_SAFE_INTEGER;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isFreshQueueSnapshot(queue: QueueSnapshot): boolean {
	const fetchedAt = Date.parse(queue.fetched_at);
	return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < QUEUE_CACHE_TTL_MS;
}

function normalizeError(error: unknown): { code: string; message: string } {
	return error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? { code: (error as { code: string }).code, message: errorMessage(error) }
		: { code: "invalid_config", message: errorMessage(error) };
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function summarizeValue(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value && typeof value === "object") return JSON.stringify(value).slice(0, 500);
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactBundleText(text: string): string {
	return text
		.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*)=([^\s\"]+)/gi, "$1=[redacted]")
		.replace(/(api[_-]?key|api[_-]?token|token|secret|password)(\"?\s*[:=]\s*\"?)([^\"\s,}]{4,})/gi, "$1$2[redacted]")
		.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}
