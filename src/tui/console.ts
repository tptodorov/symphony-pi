import type { Theme } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";

import type { Issue } from "../types.js";
import type { EligibilityReason, EligibilityReasonCode } from "../eligibility.js";
import type { QueueIssueSnapshot, QueueSnapshot } from "../orchestrator.js";
import { createConsoleStyle, fit, formatAge, formatDuration, formatInt, objectValue, padRight, stringValue, wrap, type Style } from "./format.js";
import { SymphonyConsoleDataProvider, type ConfigSnapshot, type RunArtifactSummary, type SymphonyArgs, type SymphonyControls, type TrackerIssueDetail } from "./data.js";

const TABS = ["Overview", "Queue", "Running", "Issue", "Logs", "Runs", "Config", "Help"] as const;
const WIDE_SPLIT_MIN_WIDTH = 140;
const QUEUE_AUTO_REFRESH_MS = 5_000;
type Tab = (typeof TABS)[number];
type FilterTab = "Queue" | "Running" | "Runs";
type LogMode = "global" | "selected";
type LogFilter = "all" | "error" | "warn" | "info";

type ConsoleAction = {
	id: string;
	label: string;
	description?: string;
	enabled: boolean;
	disabledReason?: string;
	run(): Promise<void> | void;
};

type Selection = { issue?: Issue; run?: RunArtifactSummary; identifier?: string; previousTab?: Tab };

type ConfirmState = { message: string; onYes: () => Promise<void> | void; requiredInput?: string; input?: string };
type AgentMessageRow = { at: string; text: string; streaming: boolean };

type ActionMenuState = { actions: ConsoleAction[]; cursor: number };
type CommandPaletteState = { actions: ConsoleAction[]; query: string; cursor: number };

export type FailureTriage = { category: string; action: string; severity: "success" | "warning" | "error" | "info" };

type TuiLike = Pick<TUI, "requestRender">;

export class SymphonyConsole implements Component {
	private readonly style: Style;
	private readonly data: SymphonyConsoleDataProvider;
	private activeTab: Tab = "Overview";
	private previousListTab: Tab = "Overview";
	private banner: { tone: "info" | "success" | "warning" | "error"; text: string } | null = null;
	private busy = false;
	private queue: QueueSnapshot | null = null;
	private config: ConfigSnapshot | null = null;
	private logs: string[] = [];
	private runs: RunArtifactSummary[] = [];
	private selected: Selection = {};
	private issueDetails = new Map<string, TrackerIssueDetail | { error: string; fetchedAt: string }>();
	private cursors: Record<FilterTab, number> = { Queue: 0, Running: 0, Runs: 0 };
	private filters: Record<FilterTab, string> = { Queue: "", Running: "", Runs: "" };
	private filtering: FilterTab | null = null;
	private actionMenu: ActionMenuState | null = null;
	private commandPalette: CommandPaletteState | null = null;
	private confirm: ConfirmState | null = null;
	private logMode: LogMode = "global";
	private logFollow = true;
	private logOffset = 0;
	private logFilter: LogFilter = "all";
	private logSearch = "";
	private searchingLogs = false;
	private rawConfig = false;
	private rawResult = false;
	private queueSimulation = false;
	private queueRefreshInFlight = false;
	private lastQueueRefreshAt = 0;
	private interval: ReturnType<typeof setInterval> | null = null;
	private version = 0;

	constructor(
		private readonly tui: TuiLike,
		theme: Theme,
		private readonly controls: SymphonyControls,
		private readonly args: SymphonyArgs,
		private readonly done: () => void,
	) {
		this.style = createConsoleStyle(theme);
		this.data = new SymphonyConsoleDataProvider(controls, args);
		this.banner = args.argError ? { tone: "error", text: args.argError } : null;
		this.interval = setInterval(() => void this.tick(), 1_000);
		void this.refreshAll();
	}

	handleInput(data: string): void {
		if (this.confirm) return this.handleConfirm(data);
		if (this.commandPalette) return this.handleCommandPalette(data);
		if (this.actionMenu) return this.handleActionMenu(data);
		if (this.filtering) return this.handleFilter(data);
		if (this.searchingLogs) return this.handleLogSearch(data);

		if (data === "q" || data === "Q") return this.done();
		if (matchesKey(data, Key.escape)) return this.handleEscape();
		if (matchesKey(data, Key.tab)) return this.switchTab(1);
		if (matchesKey(data, Key.shift("tab"))) return this.switchTab(-1);
		if (/^[1-8]$/.test(data)) return this.setTab(TABS[Number(data) - 1]!);
		if (data === "?") return this.setTab("Help");
		if (data === "a" || data === "A") return this.openActions();
		if (data === ":") return this.openCommandPalette();
		if (data === "r") return void this.refreshCurrent(true);
		if (data === "R") return void this.refreshAll(true);
		if (data === "d") return void this.startDaemon();
		if (data === "s") return void this.stopDaemonMaybeConfirm();
		if (data === "o") return void this.openDashboard();
		if (data === "x") return void this.runOnceSelected();
		if (data === "X") return void this.runOnceFirst();
		if (data === "u") return void this.openIssueUrl();
		if (data === "/" && this.isFilterTab(this.activeTab)) {
			this.filtering = this.activeTab;
			return this.requestRender();
		}
		if (data === "/" && this.activeTab === "Logs") {
			this.searchingLogs = true;
			return this.requestRender();
		}
		if (this.activeTab === "Logs") return this.handleLogInput(data);
		if (this.activeTab === "Config" && data === "v") {
			this.rawConfig = !this.rawConfig;
			return this.requestRender();
		}
		if ((this.activeTab === "Issue" || this.activeTab === "Runs") && data === "v") {
			this.rawResult = !this.rawResult;
			return this.requestRender();
		}
		if (data === "p") return void this.openSelectedPath();
		if (matchesKey(data, Key.up) || data === "k") return this.moveCursor(-1);
		if (matchesKey(data, Key.down) || data === "j") return this.moveCursor(1);
		if (matchesKey(data, Key.enter)) return this.openSelection();
	}

	render(width: number): string[] {
		const w = Math.max(width, 20);
		if (w < 40) {
			const narrow = this.activeTab === "Help" ? [this.style.title("Help"), "q close", "1 Overview", "? Help"] : [this.style.warning("Terminal too narrow for Symphony Console."), "Overview/Help only below 40 cols.", "Press ? help · q close."];
			return this.box(narrow, w);
		}
		const lines: string[] = [];
		lines.push(this.topBorder(w));
		lines.push(this.row(this.headerLine(w - 2), w));
		lines.push(this.row(this.tabLine(w - 2), w));
		if (this.banner) lines.push(this.row(this.bannerLine(w - 2), w));
		if (this.filtering) lines.push(this.row(this.style.accent(`Filter ${this.filtering}: `) + this.filters[this.filtering] + this.style.accent("▌"), w));
		if (this.searchingLogs) lines.push(this.row(this.style.accent("Search Logs: ") + this.logSearch + this.style.accent("▌"), w));
		lines.push(this.divider(w));
		const content = this.renderActive(w - 2);
		for (const line of content) lines.push(this.row(line, w));
		if (this.actionMenu) lines.push(...this.renderActionMenu(w));
		if (this.commandPalette) lines.push(...this.renderCommandPalette(w));
		if (this.confirm) lines.push(...this.renderConfirm(w));
		lines.push(this.divider(w));
		lines.push(this.row(this.footerLine(w - 2), w));
		lines.push(this.bottomBorder(w));
		this.version;
		return lines.map((line) => fit(line, w));
	}

	invalidate(): void {
		this.version++;
	}

	dispose(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = null;
	}

	private async tick(): Promise<void> {
		if (this.activeTab === "Overview" || this.activeTab === "Running") this.requestRender();
		if (this.activeTab === "Queue" && Date.now() - this.lastQueueRefreshAt >= QUEUE_AUTO_REFRESH_MS) await this.refreshQueue(true);
		if (this.activeTab === "Logs" && this.logFollow) await this.refreshLogs();
	}

	private async refreshAll(force = false): Promise<void> {
		await this.withBusy(async () => {
			this.config = await this.data.configSnapshot(force);
			this.queue = await this.data.queueSnapshot(force);
			this.lastQueueRefreshAt = Date.now();
			this.runs = await this.data.recentRuns();
			await this.refreshLogs();
			const mismatch = this.data.workflowMismatch();
			if (mismatch) this.banner = { tone: "warning", text: mismatch };
			else if (this.config && !this.config.valid) this.banner = { tone: "error", text: this.config.error?.message ?? "Config invalid" };
		});
	}

	private async refreshCurrent(force: boolean): Promise<void> {
		await this.withBusy(async () => {
			if (this.activeTab === "Queue") await this.refreshQueue(force);
			else if (this.activeTab === "Runs") this.runs = await this.data.recentRuns();
			else if (this.activeTab === "Logs") await this.refreshLogs();
			else if (this.activeTab === "Config") this.config = await this.data.configSnapshot(true);
			else this.requestRender();
		});
	}

	private async refreshQueue(force = false): Promise<void> {
		if (this.queueRefreshInFlight) return;
		this.queueRefreshInFlight = true;
		try {
			this.queue = await this.data.queueSnapshot(force);
			this.lastQueueRefreshAt = Date.now();
		} finally {
			this.queueRefreshInFlight = false;
			this.requestRender();
		}
	}

	private async refreshLogs(): Promise<void> {
		this.logs = await this.data.logTail(this.currentLogPath());
		this.requestRender();
	}

	private async withBusy(fn: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.requestRender();
		try {
			await fn();
		} catch (error) {
			this.banner = { tone: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.busy = false;
			this.requestRender();
		}
	}

	private async startDaemon(): Promise<void> {
		const mismatch = this.data.workflowMismatch();
		if (mismatch) return this.setBanner("warning", mismatch);
		const cfg = await this.data.configSnapshot(true);
		if (!cfg.valid) return this.setTab("Config", "error", cfg.error?.message ?? "Config invalid");
		await this.withBusy(async () => {
			await this.controls.startDaemon(this.args);
			this.controls.setFooterStatus("♪ daemon running");
			this.banner = { tone: "success", text: "Daemon started." };
			await this.refreshAll(true);
		});
	}

	private async stopDaemonMaybeConfirm(): Promise<void> {
		const daemon = this.data.runtime.daemon;
		if (!daemon) return this.setBanner("warning", "Daemon is not running.");
		const snapshot = objectValue(daemon.snapshot()) ?? {};
		const runningRows = Array.isArray(snapshot.running) ? (snapshot.running as Record<string, unknown>[]) : [];
		const identifiers = runningRows.map((row) => stringValue(row.issue_identifier)).filter(Boolean);
		if (identifiers.length === 0) {
			this.confirm = { message: "Stop idle daemon? y/N", onYes: () => this.stopDaemon() };
			return this.requestRender();
		}
		if (identifiers.length === 1) {
			this.confirm = { message: `Stop daemon and abort worker ${identifiers[0]}? y/N`, onYes: () => this.stopDaemon() };
			return this.requestRender();
		}
		this.confirm = { message: `Stop daemon and abort ${identifiers.length} workers: ${identifiers.join(", ")}. Type ABORT to confirm.`, requiredInput: "ABORT", input: "", onYes: () => this.stopDaemon() };
		return this.requestRender();
	}

	private async stopDaemon(): Promise<void> {
		await this.withBusy(async () => {
			await this.controls.stopDaemon();
			this.controls.setFooterStatus(undefined);
			this.banner = { tone: "success", text: "Daemon stopped." };
			await this.refreshAll(true);
		});
	}

	private async runOnceSelected(): Promise<void> {
		const row = this.currentQueueIssue();
		if (row && !row.eligibility.eligible) return this.setBanner("warning", row.eligibility.reasons[0]?.message ?? "Selected issue is not dispatchable.");
		const issue = row?.issue ?? this.selected.issue;
		if (!issue) return this.setBanner("warning", "No eligible issue selected.");
		await this.runOnce(issue.identifier);
	}

	private async runOnceFirst(): Promise<void> {
		const issue = this.queue?.eligible[0]?.issue;
		if (!issue) return this.setBanner("warning", "No eligible issue available.");
		await this.runOnce(issue.identifier);
	}

	private async refreshSelectedIssueDetails(): Promise<void> {
		const issue = this.selected.issue ?? this.currentQueueIssue()?.issue;
		if (!issue) return this.setBanner("warning", "No issue selected to refresh.");
		await this.withBusy(async () => {
			try {
				const detail = await this.data.refreshIssueDetails(issue);
				this.issueDetails.set(issue.identifier, detail);
				this.selected = { ...this.selected, issue: detail.issue, identifier: detail.issue.identifier };
				this.banner = { tone: "success", text: `Refreshed tracker details for ${detail.issue.identifier}.` };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.issueDetails.set(issue.identifier, { error: message, fetchedAt: new Date().toISOString() });
				this.banner = { tone: "error", text: `Issue refresh failed: ${message}` };
			}
		});
	}

	private async runOnce(selector: string): Promise<void> {
		if (this.data.runtime.daemon) return this.setBanner("warning", "Stop daemon before running once.");
		const cfg = await this.data.configSnapshot(true);
		if (!cfg.valid) return this.setTab("Config", "error", cfg.error?.message ?? "Config invalid");
		await this.withBusy(async () => {
			const result = await this.controls.runOnce(selector, this.args);
			this.selected = { ...this.selected, identifier: result.issueIdentifier, previousTab: this.activeTab };
			this.banner = { tone: "success", text: `Once run completed for ${result.issueIdentifier}.` };
			this.setTab("Issue");
			this.runs = await this.data.recentRuns();
			this.selected.run = this.runs.find((run) => run.path === result.artifactPath) ?? this.selected.run;
			this.logMode = "selected";
			await this.refreshLogs();
		});
	}

	private async openDashboard(): Promise<void> {
		const http = this.data.runtime.daemon?.getHttpAddress();
		if (!http?.enabled || http.port === null) return this.setBanner("warning", "Dashboard disabled. Open /symphony --port 8080, then press d.");
		const url = `http://127.0.0.1:${http.port}/`;
		try {
			await this.controls.openExternal(url);
			this.setBanner("success", `Opened dashboard: ${url}`);
		} catch (error) {
			this.setBanner("warning", `Dashboard URL: ${url} (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	private async openIssueUrl(): Promise<void> {
		const url = this.selected.issue?.url ?? this.currentQueueIssue()?.issue.url;
		if (!url) return this.setBanner("warning", `No tracker URL available for ${this.selected.identifier ?? "selection"}.`);
		await this.openExternal(url, `Opened issue URL: ${url}`);
	}

	private async openSelectedPath(): Promise<void> {
		const path = this.selected.run?.path ?? this.selected.run?.workspacePath ?? stringValue(this.currentRunningRow()?.workspace_path);
		if (!path) return this.setBanner("warning", "No path available for current selection.");
		await this.openExternal(path, `Opened path: ${path}`);
	}

	private async openRunArtifactPath(): Promise<void> {
		const run = this.currentRunSelection();
		if (!run) return this.setBanner("warning", "No run selected.");
		await this.openExternal(run.path, `Opened artifact path: ${run.path}`);
	}

	private async openRunWorkspacePath(): Promise<void> {
		const run = this.currentRunSelection();
		if (!run?.workspacePath) return this.setBanner("warning", "No workspace path available for selected run.");
		await this.openExternal(run.workspacePath, `Opened workspace path: ${run.workspacePath}`);
	}

	private async openRunLogPath(): Promise<void> {
		const run = this.currentRunSelection();
		const path = run?.logs[0];
		if (!path) return this.setBanner("warning", "No log path available for selected run.");
		await this.openExternal(path, `Opened run log path: ${path}`);
	}

	private async exportRunDebugBundle(): Promise<void> {
		const run = this.currentRunSelection();
		if (!run) return this.setBanner("warning", "No run selected.");
		await this.withBusy(async () => {
			const path = await this.data.exportRunDebugBundle(run);
			this.banner = { tone: "success", text: `Debug bundle exported: ${path}` };
			await this.openExternal(path, `Debug bundle exported and opened: ${path}`);
		});
	}

	private async jumpToRunLogs(run = this.currentRunSelection()): Promise<void> {
		if (!run?.logs[0]) return this.setBanner("warning", "No run log available for selected run.");
		this.selected = { ...this.selected, run, identifier: run.issueIdentifier, previousTab: this.activeTab };
		this.logMode = "selected";
		this.logFilter = "all";
		this.logSearch = "";
		this.logFollow = true;
		this.logs = await this.data.logTail(run.logs[0]);
		const latestError = findLastIndex(this.logs, (line) => lineMatchesLogFilter(line, "error"));
		if (latestError >= 0) {
			this.logFollow = false;
			this.logOffset = Math.max(0, this.logs.length - latestError - 1);
		}
		this.setTab("Logs", "info", `Showing logs for ${run.issueIdentifier}.`);
	}

	private async openCurrentLogPath(): Promise<void> {
		const path = this.currentLogPath();
		await this.openExternal(path, `Opened log path: ${path}`);
	}

	private toggleRawResult(): void {
		this.rawResult = !this.rawResult;
		this.setBanner("info", `Raw result JSON ${this.rawResult ? "shown" : "hidden"}.`);
	}

	private toggleRawConfig(): void {
		this.rawConfig = !this.rawConfig;
		this.setBanner("info", `Raw config ${this.rawConfig ? "shown" : "hidden"}.`);
	}

	private cycleLogSeverityFilter(): void {
		this.logFilter = nextLogFilter(this.logFilter);
		this.logOffset = 0;
		this.logFollow = true;
		this.setBanner("info", `Log severity filter: ${this.logFilter}.`);
	}

	private clearLogSearch(): void {
		this.logSearch = "";
		this.logOffset = 0;
		this.logFollow = true;
		this.setBanner("info", "Log search cleared.");
	}

	private toggleQueueSimulation(): void {
		this.queueSimulation = !this.queueSimulation;
		this.setBanner("info", `Queue simulation ${this.queueSimulation ? "shown" : "hidden"}.`);
	}

	private async openExternal(target: string, success: string): Promise<void> {
		try {
			await this.controls.openExternal(target);
			this.setBanner("success", success);
		} catch (error) {
			this.setBanner("warning", `${target} (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	private renderActive(width: number): string[] {
		if (this.activeTab === "Overview") return this.renderOverview(width);
		if (this.activeTab === "Queue") return this.renderQueue(width);
		if (this.activeTab === "Running") return this.renderRunning(width);
		if (this.activeTab === "Issue") return this.renderIssue(width);
		if (this.activeTab === "Logs") return this.renderLogs(width);
		if (this.activeTab === "Runs") return this.renderRuns(width);
		if (this.activeTab === "Config") return this.renderConfig(width);
		return this.renderHelp(width);
	}

	private renderOverview(width: number): string[] {
		const runtime = this.data.runtime;
		const snapshot = objectValue(runtime.daemon?.snapshot()) ?? {};
		const counts = objectValue(snapshot.counts) ?? {};
		const totals = objectValue(snapshot.codex_totals) ?? {};
		const http = objectValue(snapshot.http) ?? {};
		const out = [
			this.style.title("Overview"),
			`Daemon: ${runtime.daemon ? this.style.success("running") : this.style.warning("stopped")}`,
			`Once: ${runtime.onceRun ? this.style.accent(`active since ${runtime.onceRun.startedAt}`) : "idle"}`,
			`Agents: ${formatInt(counts.running)}/${formatInt(snapshot.max_concurrent_agents ?? this.config?.config?.agent.maxConcurrentAgents)}`,
			`Runtime: ${runtime.daemonStartedAt ? formatDuration((Date.now() - runtime.daemonStartedAt) / 1000) : "-"}`,
			`Tokens: in ${formatInt(totals.input_tokens)} · out ${formatInt(totals.output_tokens)} · total ${formatInt(totals.total_tokens)}`,
			`Rate limits: ${fit(JSON.stringify(snapshot.rate_limits ?? "n/a"), width - 13)}`,
			`Dashboard: ${http.enabled && http.port !== null ? `http://127.0.0.1:${http.port}/` : "disabled"}`,
			`Workflow: ${stringValue(snapshot.workflow_path) || this.config?.workflowPath || this.data.requestedWorkflowPath}`,
			`Last reload: ${stringValue(snapshot.last_reload_at) || "-"} ${snapshot.last_reload_error ? this.style.error(String(snapshot.last_reload_error)) : ""}`,
		];
		if (!runtime.daemon) out.push("", this.style.title("Start here"), "1. Open Config (7) and fix validation errors.", "2. Open Queue (2) to inspect ready issues.", "3. Press d to start daemon, or X to run the first eligible issue once.");
		if (!http.enabled) out.push(this.style.dim("Dashboard disabled: reopen /symphony --port 8080, then press d."));
		return out;
	}

	private renderQueue(width: number): string[] {
		const rows = this.filteredQueueRows();
		const selected = this.currentQueueIssue();
		const out = [this.style.title("Queue"), `Fetched: ${this.queue?.fetched_at ?? "-"}${this.queue?.error ? ` · ${this.style.error(this.queue.error)}` : ""}`];
		if ((this.queue?.eligible.length ?? 0) + (this.queue?.notDispatchable.length ?? 0) === 0 && !this.queue?.error) out.push(this.style.dim("No active tracker candidates. Recently changed tickets below may have left active states; press r to reload now."));
		if (this.queue?.error) out.push(...wrap(`Queue unavailable: ${this.queue.error}. Open Config (7), fix tracker/config, then press r.`, width));
		out.push(this.style.success("Ready to dispatch"));
		out.push(...this.renderQueueSection(rows.ready, width >= WIDE_SPLIT_MIN_WIDTH ? Math.floor(width * 0.52) : width, rows.offsets.ready));
		out.push(this.style.warning("Not dispatchable now"));
		out.push(...this.renderQueueSection(rows.notReady, width >= WIDE_SPLIT_MIN_WIDTH ? Math.floor(width * 0.52) : width, rows.offsets.notReady));
		out.push(this.style.accent("Recently changed / left active queue"));
		out.push(...this.renderQueueSection(rows.changed, width >= WIDE_SPLIT_MIN_WIDTH ? Math.floor(width * 0.52) : width, rows.offsets.changed));
		out.push(this.style.accent("Retry / backoff"));
		const retryRows = this.queue?.retrying ?? [];
		if (retryRows.length === 0) out.push(this.style.dim("  No retry/backoff items."));
		for (const retry of retryRows.slice(0, 12)) {
			const row = objectValue(retry) ?? {};
			out.push(`  ${padRight(stringValue(row.issue_identifier), 12)} ${this.style.warning("[retry]")} attempt ${formatInt(row.attempt)} due ${stringValue(row.due_at)} ${stringValue(row.error)}`);
		}
		if (this.queueSimulation) out.push(...this.renderQueueSimulation(width));
		if (selected && width >= WIDE_SPLIT_MIN_WIDTH) return this.renderSplitPane(width, "Queue list", out, `Detail ${selected.issue.identifier}`, this.renderQueueDetail(selected, Math.floor(width * 0.42)).filter(Boolean));
		if (selected) out.push(...this.renderQueueDetail(selected, width));
		return out;
	}

	private renderQueueSection(rows: QueueIssueSnapshot[], width: number, offset: number): string[] {
		if (rows.length === 0) return [this.style.dim("  None")];
		return rows.slice(0, 12).map((row, index) => {
			const absolute = offset + index;
			const prefix = absolute === this.cursors.Queue ? this.style.selected("▸") : row.eligibility.eligible && absolute === 0 ? this.style.success("◆") : " ";
			const badges = this.queueBadges(row);
			if (width < 60) return `${prefix} ${padRight(row.issue.identifier, 10)} ${padRight(row.issue.state, 10)} ${badges}`;
			if (width < 90) return `${prefix} ${padRight(row.issue.identifier, 12)} ${padRight(row.issue.state, 12)} ${padRight(badges, 18)} ${fit(row.issue.title, Math.max(8, width - 48))}`;
			const titleWidth = Math.max(10, width - 64);
			return `${prefix} ${padRight(row.issue.identifier, 12)} ${padRight(row.issue.state, 14)} ${padRight(badges, 22)} ${fit(row.issue.title, titleWidth)}`;
		});
	}

	private renderQueueSimulation(width: number): string[] {
		const cfg = this.config?.config;
		const running = this.filteredRunningRows();
		let globalSlots = Math.max((cfg?.agent.maxConcurrentAgents ?? 0) - running.length, 0);
		const byStateLimit = cfg?.agent.maxConcurrentAgentsByState ?? {};
		const usedByState = new Map<string, number>();
		for (const row of running) usedByState.set(stringValue(row.state).toLowerCase(), (usedByState.get(stringValue(row.state).toLowerCase()) ?? 0) + 1);
		const out = ["", this.style.title("Queue simulation"), this.style.dim("If the daemon tick ran now; preview only, no tracker mutation or daemon start.")];
		out.push(`Global slots available: ${globalSlots}/${cfg?.agent.maxConcurrentAgents ?? "unknown"}`);
		let dispatched = 0;
		for (const row of this.filteredQueueRows().ready) {
			const stateKey = row.issue.state.toLowerCase();
			const stateLimit = byStateLimit[stateKey];
			const used = usedByState.get(stateKey) ?? 0;
			const stateOk = stateLimit === undefined || used < stateLimit;
			if (globalSlots > 0 && stateOk) {
				dispatched++;
				globalSlots--;
				usedByState.set(stateKey, used + 1);
				out.push(`${this.style.success(`#${dispatched}`)} dispatch ${row.issue.identifier} · state ${row.issue.state} · remaining global slots ${globalSlots}`);
			} else {
				out.push(...wrap(`${this.style.warning("hold")} ${row.issue.identifier} · ${globalSlots <= 0 ? "no global slots" : `state limit ${row.issue.state} ${used}/${stateLimit}`}`, width));
			}
		}
		if (dispatched === 0) out.push(this.style.dim("No currently eligible issue would dispatch."));
		return out;
	}

	private renderQueueDetail(row: QueueIssueSnapshot, width: number): string[] {
		const out = ["", this.style.title(`Why ${row.issue.identifier} ${row.eligibility.eligible ? "can run" : "is not running"}`)];
		out.push(`State: ${row.issue.state} · Priority: ${row.issue.priority ?? "n/a"} · ${row.eligibility.eligible ? this.style.success("first eligible candidate is marked ◆") : this.style.warning("not dispatchable")}`);
		for (const reason of row.eligibility.reasons) {
			const badge = this.reasonBadge(reason.code);
			out.push(...wrap(`  ${badge} ${reason.message} ${this.reasonHint(reason)}`, width));
		}
		if (!row.eligibility.eligible) out.push(this.style.dim("Use this detail pane to resolve blockers, free slots, wait for retry, or choose another ready issue."));
		return out;
	}

	private renderRunning(width: number): string[] {
		const rows = this.filteredRunningRows();
		const selected = this.currentRunningRow();
		const listWidth = width >= WIDE_SPLIT_MIN_WIDTH ? Math.floor(width * 0.54) : width;
		const out = [this.style.title("Running"), `${rows.length} live worker(s)`];
		if (rows.length === 0) return [...out, this.style.dim("No running agents. Press d to start daemon scheduling, or X to run one eligible issue once.")];
		out.push(this.style.dim(listWidth < 80 ? "ID           ACTIVITY      STATE        AGE       MESSAGE" : "ID           ACTIVITY      STATE        PID       AGE       TURN  TOKENS  MESSAGE"));
		rows.forEach((row, i) => {
			const prefix = i === this.cursors.Running ? this.style.selected("▸") : " ";
			const activity = this.workerActivityBadge(row);
			const message = runningMessagePreview(row);
			if (listWidth < 80) out.push(`${prefix} ${padRight(stringValue(row.issue_identifier), 12)} ${padRight(activity, 13)} ${padRight(stringValue(row.state), 12)} ${padRight(formatAge(stringValue(row.started_at)), 9)} ${fit(message, Math.max(8, listWidth - 52))}`);
			else out.push(`${prefix} ${padRight(stringValue(row.issue_identifier), 12)} ${padRight(activity, 13)} ${padRight(stringValue(row.state), 12)} ${padRight(stringValue(row.pid) || "-", 9)} ${padRight(formatAge(stringValue(row.started_at)), 9)} ${padRight(formatInt(row.turn_count), 5)} ${padRight(formatInt(objectValue(row.tokens)?.total_tokens), 7)} ${fit(message, Math.max(8, listWidth - 86))}`);
		});
		if (selected && width >= WIDE_SPLIT_MIN_WIDTH) return this.renderSplitPane(width, "Running list", out, `Detail ${stringValue(selected.issue_identifier)}`, this.renderRunningDetail(selected, Math.floor(width * 0.4)));
		if (selected) out.push("", ...this.renderRunningDetail(selected, width));
		return out;
	}

	private renderRunningDetail(row: Record<string, unknown>, width: number): string[] {
		const tokens = objectValue(row.tokens) ?? {};
		const messages = agentMessagesFromRow(row).slice(-4);
		const out = [this.style.title(`Worker ${stringValue(row.issue_identifier) || "selected"}`)];
		out.push(`State: ${stringValue(row.state) || "-"} · pid=${stringValue(row.pid) || "-"} · session=${stringValue(row.session_id) || "-"}`);
		out.push(`Started: ${stringValue(row.started_at) || "-"} · last update age=${formatAge(stringValue(row.last_event_at))}`);
		out.push(`Turns: ${formatInt(row.turn_count)} · tokens=${formatInt(tokens.total_tokens)} · terminal=${stringValue(row.terminal_reason) || "-"}`);
		out.push(`Artifact: ${stringValue(row.artifact_path) || "n/a"}`);
		if (messages.length > 0) {
			out.push(this.style.title("Agent messages"));
			messages.forEach((message, index) => {
				if (index > 0) out.push("");
				out.push(...plainMessageLines(message.text, width));
			});
		} else out.push(this.style.dim("No agent text yet. Open Logs for raw runtime events."));
		out.push(this.style.dim("Enter opens Issue detail · p opens artifact/workspace path · Logs tab shows daemon log."));
		return out;
	}

	private renderIssue(width: number): string[] {
		const issue = this.selected.issue ?? this.currentQueueIssue()?.issue;
		const run = this.selected.run;
		if (!issue && !run && !this.selected.identifier) return [this.style.title("Issue"), this.style.dim("No issue selected. Press Enter on Queue, Running, or Runs.")];
		const out = [this.style.title(`Issue ${issue?.identifier ?? run?.issueIdentifier ?? this.selected.identifier ?? ""}`)];
		if (issue) {
			const detail = this.issueDetails.get(issue.identifier);
			out.push(`Title: ${issue.title}`);
			out.push(`State: ${issue.state}`);
			out.push(`URL: ${issue.url ?? "n/a"}`);
			out.push(`Source: ${detail && "issue" in detail ? `tracker refresh at ${detail.fetchedAt}` : "snapshot/artifact"}`);
			out.push(...this.renderTrackerSpecificFields(issue, width));
			if (detail && "error" in detail) out.push(this.style.error(`Refresh error at ${detail.fetchedAt}: ${detail.error}`));
			out.push(this.style.dim("Use action menu → Refresh tracker issue details for latest tracker fields."));
			out.push(...wrap(`Description: ${issue.description ?? "n/a"}`, width));
		}
		if (run) {
			out.push(...this.runDetailLines(run, width));
		}
		return out;
	}

	private renderTrackerSpecificFields(issue: Issue, width: number): string[] {
		const lines: string[] = [];
		if (issue.priority !== null) lines.push(`Priority: ${issue.priority}`);
		if (issue.branch_name) lines.push(`Branch: ${issue.branch_name}`);
		if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(", ")}`);
		if (issue.blocked_by.length > 0) lines.push(`Blocked by: ${issue.blocked_by.map((blocker) => blocker.identifier ?? blocker.id ?? "unknown").join(", ")}`);
		if (issue.created_at || issue.updated_at) lines.push(`Tracker dates: created=${issue.created_at ?? "-"} updated=${issue.updated_at ?? "-"}`);
		return lines.length > 0 ? [this.style.dim("Tracker-specific fields (secondary)"), ...lines.flatMap((line) => wrap(line, width))] : [this.style.dim("Tracker-specific fields: none in snapshot; generic Issue layout preserved.")];
	}

	private renderLogs(width: number): string[] {
		const rows = this.filteredLogs();
		const modeLabel = this.logMode === "selected" ? `selected run ${this.selected.run?.issueIdentifier ?? this.selected.identifier ?? "(none)"} · ${this.selected.run?.logs[0] ?? "(no log selected)"}` : `global ${this.data.logPath}`;
		const out = [this.style.title("Logs"), `${modeLabel} · ${this.logFollow ? "follow" : `scrolled -${this.logOffset}`}`];
		out.push(`Filter: severity=${this.logFilter} · search=${this.logSearch || "-"}`);
		out.push(this.style.dim("Keys: / search · e severity filter · ! latest error · g global · i selected · f follow"));
		const visible = Math.max(12, Math.min(30, rows.length));
		const end = this.logFollow ? rows.length : Math.max(visible, rows.length - this.logOffset);
		const start = Math.max(0, end - visible);
		const page = rows.slice(start, end);
		if (page.length === 0) out.push(this.style.dim("No log lines match the current filter/search."));
		else out.push(...page.map((line) => fit(line, width)));
		return out;
	}

	private renderRuns(width: number): string[] {
		const rows = this.filteredRuns();
		const selected = rows[this.cursors.Runs];
		const listWidth = width >= WIDE_SPLIT_MIN_WIDTH ? Math.floor(width * 0.52) : width;
		const out = [this.style.title("Runs"), `${rows.length} recent run(s)`];
		if (rows.length === 0) return [...out, this.style.dim("No .symphony/runs artifacts found. Run the daemon or x/X once, then return here to inspect artifacts.")];
		out.push(this.style.dim(listWidth < 80 ? "ID           STATUS       AGE       ERROR / ARTIFACT" : "ID           STATUS       REASON       AGE       WORKSPACE / ARTIFACT / ERROR"));
		rows.slice(0, 20).forEach((run, i) => {
			const prefix = i === this.cursors.Runs ? this.style.selected("▸") : " ";
			const detail = run.errorSummary ? `${run.errorSummary} · ${run.path}` : `${run.workspacePath ?? "no workspace"} · ${run.path}`;
			const badge = this.statusBadge(run.status, run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : run.status === "cancelled" ? "warning" : "info");
			if (listWidth < 80) out.push(`${prefix} ${padRight(run.issueIdentifier, 12)} ${padRight(badge, 12)} ${padRight(formatAge(run.mtimeMs), 9)} ${fit(detail, Math.max(10, listWidth - 40))}`);
			else out.push(`${prefix} ${padRight(run.issueIdentifier, 12)} ${padRight(badge, 12)} ${padRight(run.terminalReason || "-", 12)} ${padRight(formatAge(run.mtimeMs), 9)} ${fit(detail, Math.max(10, listWidth - 64))}`);
		});
		if (selected && width >= WIDE_SPLIT_MIN_WIDTH) return this.renderSplitPane(width, "Runs list", out, `Detail ${selected.issueIdentifier}`, this.runDetailLines(selected, Math.floor(width * 0.42)));
		if (selected) out.push("", ...this.runDetailLines(selected, width));
		return out;
	}

	private runDetailLines(run: RunArtifactSummary, width: number): string[] {
		const triage = classifyRunFailure(run);
		const out = [this.style.title(`Run ${run.issueIdentifier}`)];
		out.push(`Artifact: ${run.path}`);
		out.push(`Status: ${run.status} · terminal=${run.terminalReason || "-"} · finished=${run.finishedAt ?? "n/a"}`);
		out.push(`Workspace: ${run.workspacePath ?? "n/a"}`);
		out.push(`Logs: ${run.logs.join(", ")}`);
		out.push(this.paintTriage(triage, `Triage: ${triage.category} · ${triage.action}`));
		out.push(this.style.dim("Action: jump to logs from the action menu, or press i on Logs for selected-run mode."));
		if (run.errorSummary) out.push(...wrap(`Error: ${run.errorSummary}`, width));
		if (run.lastEvent) out.push(...wrap(`Last event: ${run.lastEvent}`, width));
		out.push(...this.renderRunTimeline(run, width));
		if (this.rawResult) out.push(...wrap(JSON.stringify(run.result, null, 2), width));
		else if (run.result) out.push(this.style.dim("Press v to toggle raw result.json preview."));
		return out;
	}

	private renderRunTimeline(run: RunArtifactSummary, width: number): string[] {
		if (run.timeline.length === 0) return [this.style.title("Timeline"), this.style.dim("No timeline metadata found in this artifact.")];
		const out = [this.style.title("Timeline")];
		let previous: string | null = null;
		for (const item of run.timeline.slice(0, 18)) {
			const delta = previous && item.at ? ` +${formatDuration(Math.max(0, (Date.parse(item.at) - Date.parse(previous)) / 1000))}` : "";
			if (item.at) previous = item.at;
			const text = `${item.at ?? "-"}${delta}  ${item.label}${item.note ? ` — ${item.note}` : ""}`;
			const paint = item.tone === "error" ? this.style.error : item.tone === "warning" ? this.style.warning : item.tone === "success" ? this.style.success : (value: string) => value;
			out.push(...wrap(paint(text), width));
		}
		return out;
	}

	private paintTriage(triage: FailureTriage, text: string): string {
		if (triage.severity === "error") return this.style.error(text);
		if (triage.severity === "warning") return this.style.warning(text);
		if (triage.severity === "success") return this.style.success(text);
		return this.style.accent(text);
	}

	private renderConfig(width: number): string[] {
		const cfg = this.config;
		if (!cfg) return [this.style.title("Config"), "Loading..."];
		const out = [this.style.title("Config"), `Workflow: ${cfg.workflowPath}`, `Validation: ${cfg.valid ? this.statusBadge("OK", "success") : this.statusBadge(cfg.error?.code ?? "error", "error")} ${cfg.valid ? "" : cfg.error?.message ?? ""}`, `Last validation: ${cfg.valid ? this.statusBadge("success", "success") : this.statusBadge("failed", "error")} at ${cfg.loadedAt}`];
		out.push(...this.renderConfigDiagnostics(cfg, width));
		const config = cfg.config;
		if (config) {
			out.push(`Tracker: ${config.tracker.kind} project=${config.tracker.projectSlug || config.tracker.jiraProjectKey || "n/a"} active=[${config.tracker.activeStates.join(", ")}]`);
			out.push(`Agent: max=${config.agent.maxConcurrentAgents} by_state=${JSON.stringify(config.agent.maxConcurrentAgentsByState)}`);
			out.push(`Workspace: ${config.workspace.root}`);
			out.push(`Codex: ${config.codex.command} turn_timeout=${config.codex.turnTimeoutMs}`);
			out.push(`Server: ${config.server.port ?? "disabled"}`);
			out.push(`Hooks: after_create=${config.hooks.afterCreate ? "set" : "-"} before_run=${config.hooks.beforeRun ? "set" : "-"} after_run=${config.hooks.afterRun ? "set" : "-"}`);
			if (this.rawConfig) out.push(...wrap(JSON.stringify(redactConfig(config), null, 2), width));
		}
		return out;
	}

	private renderConfigDiagnostics(cfg: ConfigSnapshot, width: number): string[] {
		const out = [this.style.title("Diagnostics")];
		const runningWorkflow = this.data.runtime.daemon?.getWorkflowPath();
		if (runningWorkflow && runningWorkflow !== this.data.requestedWorkflowPath) {
			out.push(...wrap(`${this.style.warning("Workflow mismatch:")} console is attached to running daemon workflow ${runningWorkflow}; requested workflow is ${this.data.requestedWorkflowPath}.`, width));
			out.push(this.style.warning("Next action: press s to stop the daemon, then reopen /symphony with the desired workflow or press d after reload."));
		}
		if (cfg.valid) {
			out.push(this.style.success("Config is valid. Press R to force reload, d to start daemon, or o to open dashboard when enabled."));
			return out;
		}
		if (cfg.error) {
			const detail = configFixDetails(cfg.error.code);
			out.push(...wrap(`Problem: ${cfg.error.code} — ${cfg.error.message}`, width));
			if (detail.fieldPath) out.push(`Field: ${detail.fieldPath}`);
			out.push(`Fix: ${detail.hint}`);
			if (detail.snippet) out.push(...wrap(`Example YAML: ${detail.snippet}`, width));
		}
		out.push(this.style.dim("After editing WORKFLOW.md or .env, press R to reload and re-run validation."));
		return out;
	}

	private renderHelp(_width: number): string[] {
		return [
			this.style.title("Help"),
			"Global keys:",
			"  Tab/Shift+Tab, 1-8 tabs · Esc back · q close · r refresh view · R refresh all · a actions · : palette",
			"Queue/Running/Runs keys:",
			"  j/k move · Enter detail · / filter · x run selected once · X run first eligible once",
			"Logs keys:",
			"  / search · e severity filter · ! latest error · g global · i selected · f/End follow · PgUp/PgDn scroll",
			"Paths and URLs:",
			"  o dashboard · u issue URL · p artifact/workspace path · a shows log/path fallbacks",
			this.style.title("Task flows"),
			"Start daemon: Config (7) must be valid → press d → watch Running/Logs.",
			"Run one issue: Queue (2) → select ready issue → press x, or press X for first eligible.",
			"Debug stuck issue: Queue simulation/why-not-running → Running detail → Logs ! latest error → Runs artifact preview.",
			"Inspect artifacts: Runs (6) → select run → Enter for Issue detail → p opens artifact/workspace path → v raw JSON.",
			"Fix config: Config (7) shows diagnostics and fix hints → edit WORKFLOW.md/.env → press R.",
			"Missing dashboard: reopen /symphony --port 8080, start daemon, then press o.",
			"Artifacts: .symphony/runs/* · Global log: .symphony/logs/symphony.log",
		];
	}

	private actions(): ConsoleAction[] {
		const daemonRunning = Boolean(this.data.runtime.daemon);
		const run = this.currentRunSelection();
		const actions: ConsoleAction[] = [
			{ id: "refresh", label: "Refresh current view", description: "Reload data for the active tab", enabled: true, run: () => this.refreshCurrent(true) },
			{ id: "refresh-all", label: "Refresh all", description: "Reload config, queue, runs, and logs", enabled: true, run: () => this.refreshAll(true) },
			{ id: "start", label: "Start daemon", enabled: !daemonRunning && !this.data.workflowMismatch(), disabledReason: daemonRunning ? "Daemon already running" : this.data.workflowMismatch() ?? undefined, run: () => this.startDaemon() },
			{ id: "stop", label: "Stop daemon", description: "Confirms when workers are running", enabled: daemonRunning, disabledReason: "Daemon is not running", run: () => this.stopDaemonMaybeConfirm() },
		];
		if (this.activeTab === "Queue") {
			actions.push(
				{ id: "queue-simulation", label: `${this.queueSimulation ? "Hide" : "Show"} queue simulation`, description: "Preview next daemon dispatch order without mutation", enabled: true, run: () => this.toggleQueueSimulation() },
				{ id: "once-selected", label: "Run once selected issue", enabled: !daemonRunning && Boolean(this.currentQueueIssue()?.eligibility.eligible), disabledReason: daemonRunning ? "Stop daemon first" : this.currentQueueIssue() ? "Selected issue is not dispatchable" : "No issue selected", run: () => this.runOnceSelected() },
				{ id: "once-first", label: "Run once first eligible", enabled: !daemonRunning && Boolean(this.queue?.eligible[0]), disabledReason: daemonRunning ? "Stop daemon first" : "No eligible issue", run: () => this.runOnceFirst() },
				{ id: "issue-url", label: "Open selected issue URL", enabled: Boolean(this.currentQueueIssue()?.issue.url), disabledReason: "No issue URL available", run: () => this.openIssueUrl() },
			);
		} else if (this.activeTab === "Logs") {
			actions.push(
				{ id: "log-path", label: "Open current log path", enabled: true, description: this.currentLogPath(), run: () => this.openCurrentLogPath() },
				{ id: "log-filter", label: "Cycle severity filter", enabled: true, description: `current: ${this.logFilter}`, run: () => this.cycleLogSeverityFilter() },
				{ id: "log-error", label: "Jump to latest error", enabled: this.logs.some((line) => lineMatchesLogFilter(line, "error")), disabledReason: "No error in current tail", run: () => this.jumpToLatestError() },
				{ id: "log-clear-search", label: "Clear log search", enabled: Boolean(this.logSearch), disabledReason: "No log search active", run: () => this.clearLogSearch() },
			);
		} else if (this.activeTab === "Runs" || this.activeTab === "Issue") {
			actions.push(
				{ id: "issue-refresh", label: "Refresh tracker issue details", enabled: Boolean(this.selected.issue ?? this.currentQueueIssue()?.issue), disabledReason: "No issue selected", run: () => this.refreshSelectedIssueDetails() },
				{ id: "jump-run-logs", label: "Jump to selected run logs", enabled: Boolean(run?.logs[0]), disabledReason: "No run log available", run: () => this.jumpToRunLogs(run ?? undefined) },
				{ id: "artifact-path", label: "Open run artifact path", enabled: Boolean(run), disabledReason: "No run selected", run: () => this.openRunArtifactPath() },
				{ id: "workspace-path", label: "Open run workspace path", enabled: Boolean(run?.workspacePath), disabledReason: "No workspace path available", run: () => this.openRunWorkspacePath() },
				{ id: "run-log", label: "Open run log path", enabled: Boolean(run?.logs[0]), disabledReason: "No run log available", run: () => this.openRunLogPath() },
				{ id: "export-debug-bundle", label: "Export selected run debug bundle", enabled: Boolean(run), disabledReason: "No run selected", run: () => this.exportRunDebugBundle() },
				{ id: "raw-result", label: `${this.rawResult ? "Hide" : "Show"} raw result JSON`, enabled: Boolean(run?.result), disabledReason: "No result.json available", run: () => this.toggleRawResult() },
			);
		} else if (this.activeTab === "Config") {
			actions.push(
				{ id: "toggle-raw-config", label: `${this.rawConfig ? "Hide" : "Show"} raw config`, enabled: Boolean(this.config?.config), disabledReason: "No valid config loaded", run: () => this.toggleRawConfig() },
				{ id: "dashboard", label: "Open dashboard", enabled: true, run: () => this.openDashboard() },
			);
		} else {
			actions.push({ id: "dashboard", label: "Open dashboard", enabled: true, run: () => this.openDashboard() });
		}
		return actions;
	}

	private openActions(): void {
		this.actionMenu = { actions: this.actions(), cursor: 0 };
		this.requestRender();
	}

	private openCommandPalette(): void {
		this.commandPalette = { actions: this.actions(), query: "", cursor: 0 };
		this.requestRender();
	}

	private renderActionMenu(width: number): string[] {
		if (!this.actionMenu) return [];
		const out = [this.divider(width), this.row(this.style.title("Actions"), width)];
		for (let i = 0; i < this.actionMenu.actions.length; i++) {
			const action = this.actionMenu.actions[i]!;
			const prefix = i === this.actionMenu.cursor ? this.style.selected("▸") : " ";
			const label = action.enabled ? action.label : this.style.dim(action.label);
			const desc = action.enabled ? action.description ?? "" : action.disabledReason ?? "disabled";
			out.push(this.row(`${prefix} ${padRight(label, 28)} ${this.style.dim(desc)}`, width));
		}
		return out;
	}

	private renderCommandPalette(width: number): string[] {
		if (!this.commandPalette) return [];
		const actions = this.filteredCommandPaletteActions();
		const out = [this.divider(width), this.row(this.style.title("Command palette") + `  :${this.commandPalette.query}${this.style.accent("▌")}`, width)];
		if (actions.length === 0) out.push(this.row(this.style.dim("No matching actions."), width));
		for (let i = 0; i < Math.min(actions.length, 8); i++) {
			const action = actions[i]!;
			const prefix = i === this.commandPalette.cursor ? this.style.selected("▸") : " ";
			const label = action.enabled ? action.label : this.style.dim(action.label);
			const desc = action.enabled ? action.description ?? "" : action.disabledReason ?? "disabled";
			out.push(this.row(`${prefix} ${padRight(label, 30)} ${this.style.dim(desc)}`, width));
		}
		return out;
	}

	private renderConfirm(width: number): string[] {
		if (!this.confirm) return [];
		const suffix = this.confirm.requiredInput ? ` Input: ${this.confirm.input ?? ""}${this.style.accent("▌")}` : "";
		return [this.divider(width), this.row(this.style.warning(this.confirm.message) + suffix, width)];
	}

	private handleActionMenu(data: string): void {
		if (!this.actionMenu) return;
		if (matchesKey(data, Key.escape) || data === "q") {
			this.actionMenu = null;
			return this.requestRender();
		}
		if (matchesKey(data, Key.up) || data === "k") this.actionMenu.cursor = Math.max(0, this.actionMenu.cursor - 1);
		else if (matchesKey(data, Key.down) || data === "j") this.actionMenu.cursor = Math.min(this.actionMenu.actions.length - 1, this.actionMenu.cursor + 1);
		else if (matchesKey(data, Key.enter)) {
			const action = this.actionMenu.actions[this.actionMenu.cursor];
			if (action?.enabled) {
				this.actionMenu = null;
				void action.run();
			} else if (action) this.setBanner("warning", action.disabledReason ?? "Action disabled");
		}
		this.requestRender();
	}

	private handleCommandPalette(data: string): void {
		if (!this.commandPalette) return;
		if (matchesKey(data, Key.escape) || data === "q") {
			this.commandPalette = null;
			return this.requestRender();
		}
		const actions = this.filteredCommandPaletteActions();
		if (matchesKey(data, Key.up) || data === "k") this.commandPalette.cursor = Math.max(0, this.commandPalette.cursor - 1);
		else if (matchesKey(data, Key.down) || data === "j") this.commandPalette.cursor = Math.min(Math.max(actions.length - 1, 0), this.commandPalette.cursor + 1);
		else if (matchesKey(data, Key.backspace)) {
			this.commandPalette.query = this.commandPalette.query.slice(0, -1);
			this.commandPalette.cursor = 0;
		} else if (matchesKey(data, Key.enter)) {
			const action = actions[this.commandPalette.cursor];
			if (action?.enabled) {
				this.commandPalette = null;
				void action.run();
			} else if (action) this.setBanner("warning", action.disabledReason ?? "Action disabled");
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.commandPalette.query += data;
			this.commandPalette.cursor = 0;
		}
		this.requestRender();
	}

	private handleConfirm(data: string): void {
		if (!this.confirm) return;
		if (this.confirm.requiredInput) {
			if (matchesKey(data, Key.escape) || data === "q") this.confirm = null;
			else if (matchesKey(data, Key.backspace)) this.confirm.input = (this.confirm.input ?? "").slice(0, -1);
			else if (matchesKey(data, Key.enter) && this.confirm.input === this.confirm.requiredInput) {
				const yes = this.confirm.onYes;
				this.confirm = null;
				void yes();
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) this.confirm.input = `${this.confirm.input ?? ""}${data}`.slice(0, this.confirm.requiredInput.length);
		} else if (data === "y" || data === "Y") {
			const yes = this.confirm.onYes;
			this.confirm = null;
			void yes();
		} else if (data === "n" || data === "N" || data === "q" || matchesKey(data, Key.escape)) {
			this.confirm = null;
		}
		this.requestRender();
	}

	private handleFilter(data: string): void {
		const tab = this.filtering;
		if (!tab) return;
		if (matchesKey(data, Key.escape)) {
			this.filters[tab] = "";
			this.filtering = null;
		} else if (matchesKey(data, Key.enter)) {
			this.filtering = null;
			this.openSelection();
		} else if (matchesKey(data, Key.backspace)) {
			this.filters[tab] = this.filters[tab].slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.filters[tab] += data;
		}
		this.cursors[tab] = 0;
		this.requestRender();
	}

	private handleLogSearch(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.logSearch = "";
			this.searchingLogs = false;
		} else if (matchesKey(data, Key.enter)) {
			this.searchingLogs = false;
		} else if (matchesKey(data, Key.backspace)) {
			this.logSearch = this.logSearch.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.logSearch += data;
		}
		this.logOffset = 0;
		this.logFollow = true;
		this.requestRender();
	}

	private handleEscape(): void {
		if (this.banner) {
			this.banner = null;
			return this.requestRender();
		}
		if (this.activeTab === "Issue" && this.selected.previousTab) return this.setTab(this.selected.previousTab);
		this.done();
	}

	private handleLogInput(data: string): void {
		const filteredLength = this.filteredLogs().length;
		if (data === "g") {
			this.logMode = "global";
			this.logFollow = true;
			void this.refreshLogs();
		} else if (data === "i") {
			this.logMode = "selected";
			this.logFollow = true;
			void this.refreshLogs();
		} else if (data === "e" || data === "E") {
			this.logFilter = nextLogFilter(this.logFilter);
			this.logOffset = 0;
			this.logFollow = true;
		} else if (data === "!") {
			this.jumpToLatestError();
		} else if (data === "f" || matchesKey(data, Key.end)) {
			this.logFollow = true;
			this.logOffset = 0;
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.logFollow = false;
			this.logOffset = Math.min(filteredLength, this.logOffset + 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.logOffset = Math.max(0, this.logOffset - 1);
			if (this.logOffset === 0) this.logFollow = true;
		} else if (matchesKey(data, Key.pageUp)) {
			this.logFollow = false;
			this.logOffset = Math.min(filteredLength, this.logOffset + 20);
		} else if (matchesKey(data, Key.pageDown)) {
			this.logOffset = Math.max(0, this.logOffset - 20);
			if (this.logOffset === 0) this.logFollow = true;
		}
		this.requestRender();
	}

	private moveCursor(delta: number): void {
		if (!this.isFilterTab(this.activeTab)) return;
		const len = this.activeTab === "Queue" ? this.filteredQueueRows().all.length : this.activeTab === "Running" ? this.filteredRunningRows().length : this.filteredRuns().length;
		this.cursors[this.activeTab] = Math.max(0, Math.min(Math.max(len - 1, 0), this.cursors[this.activeTab] + delta));
		this.requestRender();
	}

	private openSelection(): void {
		if (this.activeTab === "Queue") {
			const row = this.currentQueueIssue();
			if (row) this.selected = { issue: row.issue, identifier: row.issue.identifier, previousTab: "Queue" };
			return this.setTab("Issue");
		}
		if (this.activeTab === "Running") {
			const row = this.currentRunningRow();
			if (row) this.selected = { identifier: stringValue(row.issue_identifier), previousTab: "Running" };
			return this.setTab("Issue");
		}
		if (this.activeTab === "Runs") {
			const run = this.filteredRuns()[this.cursors.Runs];
			if (run) this.selected = { run, identifier: run.issueIdentifier, previousTab: "Runs" };
			return this.setTab("Issue");
		}
	}

	private filteredQueueRows(): { ready: QueueIssueSnapshot[]; notReady: QueueIssueSnapshot[]; changed: QueueIssueSnapshot[]; all: QueueIssueSnapshot[]; offsets: { ready: number; notReady: number; changed: number } } {
		const q = this.filters.Queue.toLowerCase();
		const matches = (row: QueueIssueSnapshot) => !q || `${row.issue.identifier} ${row.issue.title} ${row.issue.state} ${row.eligibility.reasons.map((r) => r.message).join(" ")}`.toLowerCase().includes(q);
		const ready = (this.queue?.eligible ?? []).filter(matches);
		const notReady = (this.queue?.notDispatchable ?? []).filter(matches);
		const changed = (this.queue?.recentlyChanged ?? []).filter(matches);
		return { ready, notReady, changed, all: [...ready, ...notReady, ...changed], offsets: { ready: 0, notReady: ready.length, changed: ready.length + notReady.length } };
	}

	private filteredCommandPaletteActions(): ConsoleAction[] {
		if (!this.commandPalette) return [];
		const query = this.commandPalette.query.toLowerCase();
		return this.commandPalette.actions.filter((action) => !query || `${action.label} ${action.description ?? ""} ${action.disabledReason ?? ""}`.toLowerCase().includes(query));
	}

	private currentQueueIssue(): QueueIssueSnapshot | null {
		return this.filteredQueueRows().all[this.cursors.Queue] ?? null;
	}

	private currentLogPath(): string {
		const selectedLog = this.selected.run?.logs[0];
		return this.logMode === "selected" && selectedLog ? selectedLog : this.data.logPath;
	}

	private currentRunSelection(): RunArtifactSummary | null {
		return this.activeTab === "Runs" ? this.filteredRuns()[this.cursors.Runs] ?? null : this.selected.run ?? null;
	}

	private filteredLogs(): string[] {
		const query = this.logSearch.toLowerCase();
		return this.logs.filter((line) => {
			if (this.logFilter !== "all" && !lineMatchesLogFilter(line, this.logFilter)) return false;
			return !query || line.toLowerCase().includes(query);
		});
	}

	private jumpToLatestError(): void {
		const index = findLastIndex(this.logs, (line) => lineMatchesLogFilter(line, "error"));
		if (index < 0) return this.setBanner("warning", "No error log line found in current tail.");
		this.logFilter = "all";
		this.logSearch = "";
		this.searchingLogs = false;
		this.logFollow = false;
		this.logOffset = Math.max(0, this.logs.length - index - 1);
	}

	private currentRunningRow(): Record<string, unknown> | null {
		return this.filteredRunningRows()[this.cursors.Running] ?? null;
	}

	private queueBadges(row: QueueIssueSnapshot): string {
		if (row.eligibility.eligible) return this.style.success("[ready]");
		return row.eligibility.reasons.slice(0, 3).map((reason) => this.reasonBadge(reason.code)).join(" ");
	}

	private reasonBadge(code: EligibilityReasonCode): string {
		const tone = code === "ready" ? "success" : code === "blocked" || code === "retry_backoff_active" || code === "no_global_slots" || code === "state_limit_reached" ? "warning" : "error";
		return this.statusBadge(code.replace(/_/g, "-"), tone);
	}

	private statusBadge(label: string, tone: "success" | "warning" | "error" | "info"): string {
		const text = `[${label}]`;
		if (tone === "success") return this.style.success(text);
		if (tone === "warning") return this.style.warning(text);
		if (tone === "error") return this.style.error(text);
		return this.style.accent(text);
	}

	private workerActivityBadge(row: Record<string, unknown>): string {
		const state = workerActivityState(row, this.config?.config?.codex.stallTimeoutMs ?? 300_000);
		if (state === "active") return this.statusBadge("active", "success");
		if (state === "stale") return this.statusBadge("stale", "warning");
		return this.statusBadge("quiet", "info");
	}

	private reasonHint(reason: EligibilityReason): string {
		switch (reason.code) {
			case "ready":
				return "Press x to run once, or d to let the daemon dispatch it.";
			case "missing_fields":
				return "Fix the tracker issue fields before dispatch.";
			case "inactive_state":
				return "Move the issue into one of the workflow active states.";
			case "terminal_state":
				return "Terminal issues are intentionally skipped.";
			case "already_running":
				return "Open Running or Logs to inspect the active worker.";
			case "already_claimed":
				return "The current daemon session has already claimed this issue.";
			case "completed_this_session":
				return "Wait for continuation/backoff or refresh after tracker state changes.";
			case "retry_backoff_active":
				return "Wait for the retry due time or inspect the run failure.";
			case "blocked":
				return "Resolve the listed blocker issue(s) first.";
			case "no_global_slots":
				return "Stop or wait for an active worker, or raise maxConcurrentAgents.";
			case "state_limit_reached":
				return "Wait for a worker in this state, or adjust maxConcurrentAgentsByState.";
		}
	}

	private filteredRunningRows(): Record<string, unknown>[] {
		const snapshot = objectValue(this.data.runtime.daemon?.snapshot()) ?? {};
		const rows = Array.isArray(snapshot.running) ? (snapshot.running as Record<string, unknown>[]) : [];
		const q = this.filters.Running.toLowerCase();
		return q ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q)) : rows;
	}

	private filteredRuns(): RunArtifactSummary[] {
		const q = this.filters.Runs.toLowerCase();
		return q ? this.runs.filter((run) => `${run.issueIdentifier} ${run.status} ${run.terminalReason} ${run.workspacePath ?? ""} ${run.errorSummary ?? ""} ${run.path}`.toLowerCase().includes(q)) : this.runs;
	}

	private switchTab(delta: number): void {
		const index = TABS.indexOf(this.activeTab);
		this.setTab(TABS[(index + delta + TABS.length) % TABS.length]!);
	}

	private setTab(tab: Tab, tone?: "info" | "success" | "warning" | "error", text?: string): void {
		if (this.isFilterTab(this.activeTab)) this.previousListTab = this.activeTab;
		this.activeTab = tab;
		if (tone && text) this.banner = { tone, text };
		if (tab === "Queue") void this.refreshCurrent(true);
		if (tab === "Logs") void this.refreshLogs();
		if (tab === "Runs") void this.refreshCurrent(false);
		if (tab === "Config") void this.refreshCurrent(false);
		this.requestRender();
	}

	private isFilterTab(tab: Tab): tab is FilterTab {
		return tab === "Queue" || tab === "Running" || tab === "Runs";
	}

	private setBanner(tone: "info" | "success" | "warning" | "error", text: string): void {
		this.banner = { tone, text };
		this.requestRender();
	}

	private requestRender(): void {
		this.version++;
		this.tui.requestRender();
	}

	private topBorder(width: number): string {
		return this.style.border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
	}

	private bottomBorder(width: number): string {
		return this.style.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private divider(width: number): string {
		return this.style.border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
	}

	private row(content: string, width: number): string {
		const inner = Math.max(0, width - 2);
		const clipped = fit(content, inner);
		return this.style.border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidthSafe(clipped))) + this.style.border("│");
	}

	private box(lines: string[], width: number): string[] {
		return [this.topBorder(width), ...lines.map((line) => this.row(line, width)), this.bottomBorder(width)];
	}

	private renderSplitPane(width: number, leftTitle: string, left: string[], rightTitle: string, right: string[]): string[] {
		const gap = " │ ";
		const leftWidth = Math.max(46, Math.floor((width - gap.length) * 0.56));
		const rightWidth = Math.max(32, width - gap.length - leftWidth);
		const leftLines = [this.style.accent(leftTitle), ...left];
		const rightLines = [this.style.accent(rightTitle), ...right];
		const count = Math.max(leftLines.length, rightLines.length);
		const out: string[] = [this.style.dim(`Wide split layout ≥${WIDE_SPLIT_MIN_WIDTH} cols: list left, detail right.`)];
		for (let i = 0; i < count; i++) out.push(`${padRight(leftLines[i] ?? "", leftWidth)}${this.style.border(gap)}${fit(rightLines[i] ?? "", rightWidth)}`);
		return out;
	}

	private headerLine(width: number): string {
		const runtime = this.data.runtime;
		const snapshot = objectValue(runtime.daemon?.snapshot()) ?? {};
		const counts = objectValue(snapshot.counts) ?? {};
		const totals = objectValue(snapshot.codex_totals) ?? {};
		const daemon = runtime.daemon ? this.style.success("running") : this.style.warning("stopped");
		return fit(`${this.style.title("♪ Symphony")} daemon: ${daemon} · agents ${formatInt(counts.running)}/${formatInt(snapshot.max_concurrent_agents ?? this.config?.config?.agent.maxConcurrentAgents)} · tokens ${formatInt(totals.total_tokens)}${this.busy ? " · busy" : ""}`, width);
	}

	private tabLine(width: number): string {
		return fit(TABS.map((tab, index) => (tab === this.activeTab ? this.style.selected(`${index + 1}:${tab}`) : this.style.dim(`${index + 1}:${tab}`))).join("  "), width);
	}

	private bannerLine(width: number): string {
		if (!this.banner) return "";
		const paint = this.banner.tone === "error" ? this.style.error : this.banner.tone === "warning" ? this.style.warning : this.banner.tone === "success" ? this.style.success : this.style.accent;
		return fit(paint(this.banner.text), width);
	}

	private footerLine(width: number): string {
		return fit("r refresh · R all · a actions · : palette · ? help · q close · d start · s stop · x once · / filter", width);
	}
}

function runningMessagePreview(row: Record<string, unknown>): string {
	const messages = agentMessagesFromRow(row);
	const latest = messages[messages.length - 1];
	return oneLine(latest?.text || stringValue(row.last_message) || "-");
}

function agentMessagesFromRow(row: Record<string, unknown>): AgentMessageRow[] {
	if (Array.isArray(row.recent_agent_messages)) {
		return row.recent_agent_messages
			.map((message) => objectValue(message))
			.filter((message): message is Record<string, unknown> => Boolean(message))
			.map((message) => ({ at: stringValue(message.at), text: stringValue(message.text), streaming: Boolean(message.streaming) }))
			.filter((message) => message.text.trim().length > 0);
	}

	const events = Array.isArray(row.recent_events) ? (row.recent_events as Record<string, unknown>[]) : [];
	const messages: AgentMessageRow[] = [];
	let current = "";
	let at = "";
	for (const event of events) {
		const name = stringValue(event.event);
		if (name === "item_agentMessage_delta") {
			if (!current) at = stringValue(event.at);
			current += stringValue(event.message);
		} else if (current) {
			messages.push({ at, text: current, streaming: false });
			current = "";
			at = "";
		}
	}
	if (current) messages.push({ at, text: current, streaming: true });
	return messages;
}

function plainMessageLines(text: string, width: number): string[] {
	const trimmed = text.trimEnd();
	if (!trimmed) return ["-"];
	return trimmed.split(/\r?\n/).flatMap((line) => wrap(line || " ", Math.max(20, width - 2)));
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim() || "-";
}

export function workerActivityState(row: Record<string, unknown>, stallTimeoutMs: number, now = Date.now()): "active" | "stale" | "quiet" {
	const at = stringValue(row.last_event_at) || stringValue(row.started_at);
	if (!at) return "quiet";
	const ageMs = now - Date.parse(at);
	if (!Number.isFinite(ageMs)) return "quiet";
	return ageMs > stallTimeoutMs ? "stale" : "active";
}

export function classifyRunFailure(run: Pick<RunArtifactSummary, "status" | "terminalReason" | "errorSummary" | "lastEvent">): FailureTriage {
	const text = `${run.status} ${run.terminalReason} ${run.errorSummary ?? ""} ${run.lastEvent ?? ""}`.toLowerCase();
	if (run.status === "succeeded" || run.terminalReason === "succeeded") return { category: "succeeded", action: "No failure action needed.", severity: "success" };
	if (/config|workflow|front matter|yaml|missing_.*(key|token|kind|command)|invalid_config/.test(text)) return { category: "config", action: "Open Config, fix WORKFLOW.md or .env, then press R.", severity: "error" };
	if (/tracker|linear|jira|beads|graphql|jql|api key|unauthori[sz]ed|forbidden|rate limit/.test(text)) return { category: "tracker", action: "Check tracker credentials, project filters, rate limits, and issue state.", severity: "error" };
	if (/turn_timeout|response_timeout|timed_out|timeout/.test(text)) return { category: "codex timeout", action: "Inspect run logs, reduce scope, or raise codex turn timeout.", severity: "warning" };
	if (/turn_input_required|input required|approval|user input/.test(text)) return { category: "user input required", action: "Inspect prompt/tool request and make the run non-interactive before retrying.", severity: "warning" };
	if (/after_create|before_run|after_run|hook/.test(text)) return { category: "hook failure", action: "Run the configured hook locally in the workspace and fix its command/output.", severity: "error" };
	if (/workspace|worktree|checkout|branch|git|createForIssue|permission denied|enoent/.test(text)) return { category: "workspace failure", action: "Check workspace root, git state, branch creation, and filesystem permissions.", severity: "error" };
	if (/stall|stalled|quiet|last event/.test(text)) return { category: "stall", action: "Open logs around the last event and abort/retry if the worker is quiet past the stall threshold.", severity: "warning" };
	if (run.status === "in_progress") return { category: "in progress", action: "Watch Running/Logs for fresh events before intervening.", severity: "info" };
	return { category: run.status === "failed" ? "failed" : "unknown", action: "Jump to selected run logs and inspect the latest error context.", severity: run.status === "failed" ? "error" : "info" };
}

export function configFixDetails(code: string): { hint: string; fieldPath: string | null; snippet: string | null } {
	switch (code) {
		case "invalid_args":
			return { fieldPath: null, snippet: null, hint: "Use /symphony [--port 8080] [WORKFLOW.md] or /symphony --workflow path/to/WORKFLOW.md." };
		case "missing_workflow_file":
			return { fieldPath: null, snippet: null, hint: "Create WORKFLOW.md at the shown path, or reopen /symphony with the correct workflow path." };
		case "workflow_parse_error":
		case "workflow_front_matter_not_a_map":
			return { fieldPath: "front matter", snippet: "---\ntracker:\n  kind: beads\n---", hint: "Fix WORKFLOW.md YAML front matter; it must be a valid object between --- markers." };
		case "missing_tracker_kind":
			return { fieldPath: "tracker.kind", snippet: "tracker:\n  kind: beads", hint: "Add tracker.kind: linear, jira, or beads to WORKFLOW.md front matter." };
		case "unsupported_tracker_kind":
			return { fieldPath: "tracker.kind", snippet: "tracker:\n  kind: linear", hint: "Use one of the supported tracker kinds: linear, jira, beads." };
		case "missing_tracker_api_key":
			return { fieldPath: "tracker.api_key", snippet: "tracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY", hint: "Set the Linear API key in WORKFLOW.md or workflow .env, then press R." };
		case "missing_tracker_project_slug":
			return { fieldPath: "tracker.project_slug", snippet: "tracker:\n  project_slug: ENG", hint: "Set tracker.project_slug for Linear dispatch." };
		case "missing_jira_email":
			return { fieldPath: "tracker.email", snippet: "tracker:\n  email: $JIRA_EMAIL", hint: "Set tracker.email or the matching Jira email environment variable." };
		case "missing_jira_api_token":
			return { fieldPath: "tracker.api_token", snippet: "tracker:\n  api_token: $JIRA_API_TOKEN", hint: "Set tracker.api_token or the matching Jira API token environment variable." };
		case "missing_jira_project_key":
			return { fieldPath: "tracker.project_key", snippet: "tracker:\n  project_key: ABC", hint: "Set tracker.project_key or tracker.jql for Jira Cloud." };
		case "missing_codex_command":
			return { fieldPath: "codex.command", snippet: "codex:\n  command: codex app-server", hint: "Set codex.command to the Codex CLI command available in this environment." };
		default:
			return { fieldPath: null, snippet: null, hint: "Review the displayed error, WORKFLOW.md front matter, and workflow .env values." };
	}
}

function nextLogFilter(filter: LogFilter): LogFilter {
	if (filter === "all") return "error";
	if (filter === "error") return "warn";
	if (filter === "warn") return "info";
	return "all";
}

function lineMatchesLogFilter(line: string, filter: Exclude<LogFilter, "all">): boolean {
	if (filter === "error") return /\b(error|failed|failure|exception|fatal)\b/i.test(line);
	if (filter === "warn") return /\b(warn|warning)\b/i.test(line);
	return /\binfo\b/i.test(line);
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
	for (let i = values.length - 1; i >= 0; i--) if (predicate(values[i]!)) return i;
	return -1;
}

function visibleWidthSafe(value: string): number {
	return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function redactConfig(config: unknown): unknown {
	return JSON.parse(
		JSON.stringify(config, (key, value) => (/apiKey|apiToken|token|secret|password/i.test(key) && value ? "[redacted]" : value)),
	) as unknown;
}
