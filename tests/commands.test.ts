import test from "node:test";
import assert from "node:assert/strict";

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { registerSymphonyCommands } from "../src/commands.js";
import { SymphonyConsole, classifyRunFailure, configFixDetails, workerActivityState } from "../src/tui/console.js";
import { parseSymphonyArgs, type SymphonyControls } from "../src/tui/data.js";
import type { QueueSnapshot } from "../src/orchestrator.js";
import type { Issue } from "../src/types.js";

test("registerSymphonyCommands registers single Symphony console command", () => {
	const commands: string[] = [];
	const pi = {
		registerCommand(name: string): void {
			commands.push(name);
		},
		on(): void {},
	};

	registerSymphonyCommands(pi as never);

	assert.deepEqual(commands, ["symphony"]);
});

test("Symphony extension status includes active and configured agent counts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-symphony-status-"));
	const workflow = join(dir, "WORKFLOW.md");
	await writeFile(
		workflow,
		`---
tracker:
  kind: beads
  command: 'node -e "console.log([])"'
  ready_command: 'node -e "console.log([])"'
agent:
  max_concurrent_agents: 3
polling:
  interval_ms: 60000
---
Task
`,
		"utf8",
	);
	let command: any;
	let shutdown: any;
	let symphonyConsole: any;
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerCommand(_name: string, definition: { handler(args: string, ctx: unknown): Promise<void> }): void {
			command = definition;
		},
		on(event: string, handler: () => Promise<void>): void {
			if (event === "session_shutdown") shutdown = handler;
		},
	};
	registerSymphonyCommands(pi as never);
	const ctx = {
		cwd: dir,
		hasUI: true,
		ui: {
			notify: () => {},
			setStatus: (id: string, value: string | undefined) => {
				if (id === "symphony") statuses.push(value);
			},
			custom: async (factory: any) => {
				symphonyConsole = factory({ requestRender: () => {} }, fakeTheme(), {}, () => {});
			},
		},
	};

	try {
		await command.handler(`--workflow ${workflow}`, ctx);
		symphonyConsole.handleInput("d");
		await sleep(100);
		assert.equal(statuses.includes("♪ daemon running (0/3)"), true, statuses.join(", "));
	} finally {
		symphonyConsole?.dispose();
		if (shutdown) await shutdown();
	}
});

test("parseSymphonyArgs supports workflow and port grammar", () => {
	assert.deepEqual(parseSymphonyArgs(""), {});
	assert.deepEqual(parseSymphonyArgs("--port 8080 WORKFLOW.md"), { port: 8080, workflowPath: "WORKFLOW.md" });
	assert.deepEqual(parseSymphonyArgs("--workflow custom.md --port=0"), { workflowPath: "custom.md", port: 0 });
	assert.equal(parseSymphonyArgs("--bad").argError, "Unknown option: --bad");
});

test("SymphonyConsole renders shell, help, and Config diagnostics", async () => {
	let renders = 0;
	let closed = false;
	let daemonActive = true;
	let stopped = false;
	const dir = process.cwd();
	const controls: SymphonyControls = {
		cwd: dir,
		getRuntime: () => ({
			daemon: daemonActive
				? ({
						queueSnapshot: async () => ({ eligible: [], notDispatchable: [], recentlyChanged: [], retrying: [], fetched_at: "now", error: null }),
						getWorkflowPath: () => join(dir, "OTHER.md"),
						getHttpAddress: () => ({ enabled: false, port: null }),
						snapshot: () => ({ counts: { running: 1 }, running: [{ issue_identifier: "ABC-1" }], max_concurrent_agents: 1 }),
					} as any)
				: null,
			daemonStartedAt: daemonActive ? Date.now() : null,
			onceRun: null,
		}),
		startDaemon: async () => {},
		stopDaemon: async () => {
			stopped = true;
			daemonActive = false;
		},
		runOnce: async () => ({ issueIdentifier: "ABC-1", workspacePath: null, artifactPath: null }),
		openExternal: async () => {},
		setFooterStatus: () => {},
	};
	const console = new SymphonyConsole({ requestRender: () => renders++ }, fakeTheme(), controls, { workflowPath: "REQUESTED.md", argError: "Unknown option: --bad" }, () => {
		closed = true;
	});
	try {
		await sleep(5);
		assert.match(console.render(35).join("\n"), /Overview\/Help only/);
		assert.match(console.render(100).join("\n"), /Symphony/);
		console.handleInput("?");
		const help = console.render(140).join("\n");
		assert.match(help, /Help/);
		assert.match(help, /Debug stuck issue/);
		assert.match(help, /: palette/);
		assert.match(help, /Fix config/);
		console.handleInput(":");
		for (const char of "stop") console.handleInput(char);
		let palette = console.render(180).join("\n");
		assert.match(palette, /Command palette/);
		assert.match(palette, /Stop daemon/);
		console.handleInput("\u001b");
		console.handleInput("7");
		const config = console.render(180).join("\n");
		assert.match(config, /Workflow mismatch/);
		assert.match(config, /press s to stop the daemon/i);
		assert.match(config, /invalid_args/);
		assert.match(config, /Use \/symphony/);
		assert.match(config, /Last validation: \[failed\] at/);
		console.handleInput("a");
		let actions = console.render(180).join("\n");
		assert.match(actions, /Stop daemon/);
		console.handleInput("j");
		console.handleInput("j");
		console.handleInput("j");
		console.handleInput("\r");
		assert.match(console.render(180).join("\n"), /Stop daemon and abort worker ABC-1/);
		console.handleInput("y");
		assert.equal(stopped, true);
		console.handleInput("q");
		assert.equal(closed, true);
		assert.equal(renders > 0, true);
	} finally {
		console.dispose();
	}
});

test("SymphonyConsole Logs supports search, severity filter, and jump-to-error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-symphony-logs-"));
	const workflow = join(dir, "WORKFLOW.md");
	const logDir = join(dir, ".symphony", "logs");
	await mkdir(logDir, { recursive: true });
	await writeFile(workflow, "# test\n", "utf8");
	await writeFile(join(logDir, "symphony.log"), ["INFO boot", "WARN slow tracker", "ERROR boom failed", "INFO recovered"].join("\n"), "utf8");
	const runDir = join(dir, ".symphony", "runs", "2026-05-03_ABC-9_attempt-1");
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "metadata.json"), JSON.stringify({ issue_identifier: "ABC-9", started_at: "2026-05-03T18:59:00Z", workspace_path: "/tmp/work/ABC-9" }, null, 2), "utf8");
	await writeFile(join(runDir, "events.jsonl"), [
		JSON.stringify({ timestamp: "2026-05-03T18:59:05Z", event: "session_started", session_id: "sess-1" }),
		JSON.stringify({ timestamp: "2026-05-03T18:59:40Z", event: "turn_failed", message: "ERROR model failed loudly OPENAI_API_KEY=sk-123456789012345" }),
	].join("\n"), "utf8");
	await writeFile(join(runDir, "result.json"), JSON.stringify({ status: "failed", terminal_reason: "failed", finished_at: "2026-05-03T19:00:00Z", issue_identifier: "ABC-9", workspace_path: "/tmp/work/ABC-9", last_error: "model failed loudly", last_event: { event: "turn_failed" } }, null, 2), "utf8");
	const controls: SymphonyControls = {
		cwd: dir,
		getRuntime: () => ({ daemon: null, daemonStartedAt: null, onceRun: null }),
		startDaemon: async () => {},
		stopDaemon: async () => {},
		runOnce: async () => ({ issueIdentifier: "ABC-1", workspacePath: null, artifactPath: null }),
		openExternal: async () => {},
		setFooterStatus: () => {},
	};
	const console = new SymphonyConsole({ requestRender: () => {} }, fakeTheme(), controls, { workflowPath: workflow }, () => {});
	try {
		await sleep(20);
		console.handleInput("5");
		console.handleInput("a");
		let actions = console.render(220).join("\n");
		assert.match(actions, /Open current log path/);
		assert.match(actions, /Cycle severity filter/);
		console.handleInput("\u001b");
		console.handleInput("/");
		for (const char of "boom") console.handleInput(char);
		console.handleInput("\r");
		let rendered = console.render(220).join("\n");
		assert.match(rendered, /search=boom/);
		assert.match(rendered, /ERROR boom failed/);
		assert.doesNotMatch(rendered, /INFO boot/);
		console.handleInput("/");
		console.handleInput("\u001b");
		console.handleInput("e");
		rendered = console.render(220).join("\n");
		assert.match(rendered, /severity=error/);
		assert.match(rendered, /ERROR boom failed/);
		assert.doesNotMatch(rendered, /WARN slow tracker/);
		console.handleInput("!");
		rendered = console.render(220).join("\n");
		assert.match(rendered, /scrolled -1/);
		console.handleInput("6");
		rendered = console.render(220).join("\n");
		assert.match(rendered, /Wide split layout/);
		assert.match(rendered, /Runs list/);
		assert.match(rendered, /Detail ABC-9/);
		assert.match(rendered, /ABC-9/);
		assert.match(rendered, /model failed loudly/);
		assert.match(rendered, /\/tmp\/work\/ABC-9/);
		assert.match(rendered, /Triage: failed/);
		assert.match(rendered, /Timeline/);
		assert.match(rendered, /claimed/);
		assert.match(rendered, /session_started/);
		assert.match(rendered, /turn_failed/);
		assert.match(rendered, /result:failed/);
		assert.doesNotMatch(console.render(70).join("\n"), /Wide split layout/);
		assert.match(rendered, /Press v to toggle raw result\.json preview/);
		console.handleInput("v");
		rendered = console.render(220).join("\n");
		assert.match(rendered, /"last_error": "model failed loudly"/);
		console.handleInput(":");
		for (const char of "debug") console.handleInput(char);
		assert.match(console.render(220).join("\n"), /Export selected run debug bun/);
		console.handleInput("\r");
		await sleep(5);
		const bundle = await readFile(join(runDir, "debug-bundle.json"), "utf8");
		assert.match(bundle, /"issue_identifier": "ABC-9"/);
		assert.match(bundle, /"log_excerpt"/);
		assert.doesNotMatch(bundle, /sk-123456789012345/);
		assert.match(bundle, /OPENAI_API_KEY=\[redacted\]/);
		console.handleInput("a");
		actions = console.render(220).join("\n");
		assert.match(actions, /Jump to selected run logs/);
		assert.match(actions, /Open run artifact path/);
		assert.match(actions, /Open run workspace path/);
		assert.match(actions, /Open run log path/);
		assert.match(actions, /Export selected run debug b/);
		for (let i = 0; i < 5; i++) console.handleInput("j");
		console.handleInput("\r");
		await sleep(5);
		rendered = console.render(220).join("\n");
		assert.match(rendered, /selected run ABC-9/);
		assert.match(rendered, /ERROR model failed loudly/);
	} finally {
		console.dispose();
	}
});

test("SymphonyConsole Queue explains why selected issues are or are not running", async () => {
	const ready = fakeIssue("ready-1", "ABC-1", "Todo", "Ready issue");
	const blocked = { ...fakeIssue("blocked-1", "ABC-B", "Todo", "Blocked issue"), labels: ["bug", "linear"], branch_name: "fix/abc-b", blocked_by: [{ id: "blocker-1", identifier: "ABC-0", state: "Todo" }] };
	const queue: QueueSnapshot = {
		eligible: [{ issue: ready, eligibility: { eligible: true, reasons: [{ code: "ready", message: "Ready to dispatch." }] } }],
		notDispatchable: [{ issue: blocked, eligibility: { eligible: false, reasons: [{ code: "blocked", message: "Blocked by ABC-0." }, { code: "no_global_slots", message: "No global agent slots available (1/1)." }] } }],
		recentlyChanged: [{ issue: fakeIssue("review-1", "ABC-REV", "Review", "In review"), eligibility: { eligible: false, reasons: [{ code: "inactive_state", message: "State Review is not in active_states." }] } }],
		retrying: [{ issue_identifier: "ABC-R", attempt: 2, due_at: "soon", error: "boom" }],
		fetched_at: "now",
		error: null,
	};
	const controls: SymphonyControls = {
		cwd: process.cwd(),
		getRuntime: () => ({
			daemon: {
					queueSnapshot: async () => queue,
					refreshIssueDetails: async (issue: Issue) => ({ ...issue, title: "Fresh tracker title", state: "In Progress", description: "Fresh tracker description" }),
					getWorkflowPath: () => "",
					getHttpAddress: () => ({ enabled: false, port: null }),
					snapshot: () => ({ counts: { running: 1 }, running: [{ issue_identifier: "ABC-RUN", state: "Doing", pid: 123, started_at: "2026-05-03T19:00:00Z", last_event_at: "2026-05-03T19:01:00Z", last_event: "agent_message", turn_count: 2, tokens: { total_tokens: 99 }, artifact_path: "/tmp/artifact", recent_events: [{ at: "2026-05-03T19:01:00Z", event: "turn_completed", message: "ok" }], recent_agent_messages: [{ at: "2026-05-03T19:00:30Z", text: "Working on ABC-RUN", streaming: true }] }], max_concurrent_agents: 1 }),
				} as any,
			daemonStartedAt: Date.now(),
			onceRun: null,
		}),
		startDaemon: async () => {},
		stopDaemon: async () => {},
		runOnce: async () => ({ issueIdentifier: "ABC-1", workspacePath: null, artifactPath: null }),
		openExternal: async () => {},
		setFooterStatus: () => {},
	};
	const console = new SymphonyConsole({ requestRender: () => {} }, fakeTheme(), controls, {}, () => {});
	try {
		await sleep(20);
		console.handleInput("2");
		let rendered = console.render(180).join("\n");
		assert.match(rendered, /Wide split layout/);
		assert.match(rendered, /Queue list/);
		assert.match(rendered, /Detail ABC-1/);
		assert.match(rendered, /\[ready\]/);
		assert.match(rendered, /first eligible candidate/);
		assert.doesNotMatch(console.render(55).join("\n"), /Wide split layout/);
		console.handleInput(":");
		for (const char of "simulation") console.handleInput(char);
		assert.match(console.render(180).join("\n"), /Show queue simulation/);
		console.handleInput("\r");
		rendered = console.render(180).join("\n");
		assert.match(rendered, /Queue simulation/);
		assert.match(rendered, /preview only, no tracker mutation/);
		console.handleInput("j");
		rendered = console.render(120).join("\n");
		assert.match(rendered, /Why ABC-B is not running/);
		assert.match(rendered, /\[blocked\]/);
		assert.match(rendered, /Resolve the listed blocker/);
		assert.match(rendered, /\[no-global-slots\]/);
		assert.match(rendered, /ABC-REV\s+Review/);
		assert.match(rendered, /ABC-R.*\[retry\]/);
		assert.match(console.render(55).join("\n"), /ABC-B\s+Todo\s+\[blocked\]/);
		console.handleInput("\r");
		rendered = console.render(120).join("\n");
		assert.match(rendered, /Source: snapshot\/artifact/);
		assert.match(rendered, /Tracker-specific fields \(secondary\)/);
		assert.match(rendered, /Branch: fix\/abc-b/);
		assert.match(rendered, /Labels: bug, linear/);
		assert.match(rendered, /Blocked by: ABC-0/);
		console.handleInput("a");
		assert.match(console.render(120).join("\n"), /Refresh tracker issue details/);
		for (let i = 0; i < 4; i++) console.handleInput("j");
		console.handleInput("\r");
		await sleep(5);
		rendered = console.render(120).join("\n");
		assert.match(rendered, /Fresh tracker title/);
		assert.match(rendered, /Source: tracker refresh at/);
		assert.match(rendered, /Fresh tracker description/);
		console.handleInput("3");
		rendered = console.render(180).join("\n");
		assert.match(rendered, /Wide split layout/);
		assert.match(rendered, /Running list/);
		assert.match(rendered, /Detail ABC-RUN/);
		assert.match(rendered, /Agent messages/);
		assert.match(rendered, /Working on ABC-RUN/);
		assert.doesNotMatch(console.render(70).join("\n"), /Wide split layout/);
	} finally {
		console.dispose();
	}
});

test("SymphonyConsole stop confirmation distinguishes idle, single, and multi-worker aborts", async () => {
	let runningRows: Record<string, unknown>[] = [];
	let stopped = 0;
	const controls: SymphonyControls = {
		cwd: process.cwd(),
		getRuntime: () => ({
			daemon: {
				queueSnapshot: async () => ({ eligible: [], notDispatchable: [], recentlyChanged: [], retrying: [], fetched_at: "now", error: null }),
				getWorkflowPath: () => "",
				getHttpAddress: () => ({ enabled: false, port: null }),
				snapshot: () => ({ counts: { running: runningRows.length }, running: runningRows, max_concurrent_agents: 2 }),
			} as any,
			daemonStartedAt: Date.now(),
			onceRun: null,
		}),
		startDaemon: async () => {},
		stopDaemon: async () => {
			stopped++;
		},
		runOnce: async () => ({ issueIdentifier: "ABC-1", workspacePath: null, artifactPath: null }),
		openExternal: async () => {},
		setFooterStatus: () => {},
	};
	const console = new SymphonyConsole({ requestRender: () => {} }, fakeTheme(), controls, {}, () => {});
	try {
		await sleep(5);
		console.handleInput("s");
		assert.match(console.render(160).join("\n"), /Stop idle daemon\? y\/N/);
		console.handleInput("n");
		runningRows = [{ issue_identifier: "ABC-1" }];
		console.handleInput("s");
		assert.match(console.render(160).join("\n"), /abort worker ABC-1\? y\/N/);
		console.handleInput("n");
		runningRows = [{ issue_identifier: "ABC-1" }, { issue_identifier: "ABC-2" }];
		console.handleInput("s");
		let rendered = console.render(180).join("\n");
		assert.match(rendered, /ABC-1, ABC-2/);
		assert.match(rendered, /Type ABORT to confirm/);
		for (const char of "ABORT") console.handleInput(char);
		console.handleInput("\r");
		assert.equal(stopped, 1);
	} finally {
		console.dispose();
	}
});

test("config fix details include field paths and redacted-safe snippets", () => {
	const linear = configFixDetails("missing_tracker_api_key");
	assert.equal(linear.fieldPath, "tracker.api_key");
	assert.match(linear.snippet ?? "", /\$LINEAR_API_KEY/);
	assert.doesNotMatch(linear.snippet ?? "", /sk-/);
	const codex = configFixDetails("missing_codex_command");
	assert.equal(codex.fieldPath, "codex.command");
	assert.match(codex.snippet ?? "", /codex app-server/);
});

test("workerActivityState classifies active and stale rows with deterministic timestamps", () => {
	const now = Date.parse("2026-05-03T20:00:00Z");
	assert.equal(workerActivityState({ last_event_at: "2026-05-03T19:59:50Z" }, 60_000, now), "active");
	assert.equal(workerActivityState({ last_event_at: "2026-05-03T19:58:00Z" }, 60_000, now), "stale");
	assert.equal(workerActivityState({}, 60_000, now), "quiet");
});

test("classifyRunFailure covers deterministic failure triage categories", () => {
	const cases = [
		["config", { status: "failed", terminalReason: "failed", errorSummary: "invalid_config missing_tracker_kind", lastEvent: null }],
		["tracker", { status: "failed", terminalReason: "failed", errorSummary: "Linear GraphQL unauthorized", lastEvent: null }],
		["codex timeout", { status: "failed", terminalReason: "timed_out", errorSummary: "turn_timeout", lastEvent: null }],
		["user input required", { status: "failed", terminalReason: "user_input_required", errorSummary: "turn_input_required", lastEvent: null }],
		["hook failure", { status: "failed", terminalReason: "failed", errorSummary: "before_run hook exited 1", lastEvent: null }],
		["workspace failure", { status: "failed", terminalReason: "failed", errorSummary: "workspace git checkout failed", lastEvent: null }],
		["stall", { status: "cancelled", terminalReason: "stalled", errorSummary: "worker stalled", lastEvent: null }],
	] as const;
	for (const [category, run] of cases) assert.equal(classifyRunFailure(run).category, category);
});

function fakeIssue(id: string, identifier: string, state: string, title: string): Issue {
	return {
		id,
		identifier,
		title,
		description: null,
		priority: 1,
		state,
		branch_name: null,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: null,
		updated_at: null,
	};
}

function fakeTheme(): any {
	return {
		fg: (_name: string, text: string) => text,
		bg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	};
}
