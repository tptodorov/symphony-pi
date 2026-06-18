import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { evaluateIssueEligibility, sortIssuesForDispatch } from "../src/eligibility.js";
import { createConsoleLogger } from "../src/logger.js";
import { SymphonyOrchestrator } from "../src/orchestrator.js";
import type { Issue, Logger, RunningEntry, SymphonyConfig } from "../src/types.js";

const logger = createConsoleLogger("test");

test("pure eligibility helpers sort and explain dispatch reasons", () => {
	const cfg = baseConfig();
	cfg.agent = { ...cfg.agent, maxConcurrentAgents: 1, maxConcurrentAgentsByState: { todo: 1 } };
	const runningTodo = runningEntry(issue("run-1", "ABC-R", { state: "Todo" }));
	const runtime = {
		running: [runningTodo],
		runningIds: new Set(["run-1"]),
		claimedIds: new Set(["claimed-1"]),
		completedIds: new Set(["done-1"]),
		retryingIds: new Set(["retry-1"]),
	};
	assert.deepEqual(
		sortIssuesForDispatch([
			issue("id-2", "ABC-2", { priority: 2 }),
			issue("id-1", "ABC-1", { priority: 1 }),
		]).map((candidate) => candidate.identifier),
		["ABC-1", "ABC-2"],
	);
	assert.equal(evaluateIssueEligibility(issue("ready-1", "ABC-IP", { state: "In Progress" }), { ...runtime, running: [], runningIds: new Set(), claimedIds: new Set(), completedIds: new Set(), retryingIds: new Set() }, cfg).eligible, true);
	assert.equal(evaluateIssueEligibility(issue("claimed-1", "ABC-C", { state: "In Progress" }), runtime, cfg).reasons.some((reason) => reason.code === "already_claimed"), true);
	assert.equal(evaluateIssueEligibility(issue("blocked-1", "ABC-B", { state: "Todo", blocked_by: [{ id: "x", identifier: "ABC-X", state: "Todo" }] }), runtime, cfg).reasons.some((reason) => reason.code === "blocked"), true);
	assert.equal(evaluateIssueEligibility(issue("slot-1", "ABC-S", { state: "In Progress" }), runtime, cfg).reasons.some((reason) => reason.code === "no_global_slots"), true);
});

test("orchestrator dispatch sorting uses priority, created_at, then identifier", () => {
	const orchestrator = configuredOrchestrator();
	const sorted = priv(orchestrator).sortForDispatch([
		issue("id-3", "ZZZ-3", { priority: null, created_at: "2026-01-01T00:00:00Z" }),
		issue("id-2", "ABC-2", { priority: 1, created_at: "2026-01-03T00:00:00Z" }),
		issue("id-1", "ABC-1", { priority: 1, created_at: "2026-01-02T00:00:00Z" }),
		issue("id-4", "ABC-4", { priority: 2, created_at: "2026-01-01T00:00:00Z" }),
	]);

	assert.deepEqual(sorted.map((candidate: Issue) => candidate.identifier), ["ABC-1", "ABC-2", "ABC-4", "ZZZ-3"]);
});

test("orchestrator eligibility covers state, claimed/running guards, blockers, and per-state concurrency", () => {
	const orchestrator = configuredOrchestrator({
		agent: { ...baseConfig().agent, maxConcurrentAgents: 3, maxConcurrentAgentsByState: { todo: 1 } },
	});
	const runningTodo = runningEntry(issue("run-1", "ABC-0", { state: "Todo" }));
	priv(orchestrator).state.running.set("run-1", runningTodo);
	priv(orchestrator).state.claimed.add("claimed-1");

	assert.equal(priv(orchestrator).shouldDispatch(issue("done-1", "ABC-D", { state: "Done" })), false);
	assert.equal(priv(orchestrator).shouldDispatch(issue("claimed-1", "ABC-C", { state: "In Progress" })), false);
	assert.equal(priv(orchestrator).shouldDispatch(issue("run-1", "ABC-R", { state: "In Progress" })), false);
	assert.equal(
		priv(orchestrator).shouldDispatch(
			issue("blocked-1", "ABC-B", { state: "Todo", blocked_by: [{ id: "x", identifier: "ABC-X", state: "In Progress" }] }),
		),
		false,
	);
	assert.equal(
		priv(orchestrator).shouldDispatch(
			issue("blocked-2", "ABC-E", { state: "Todo", blocked_by: [{ id: "x", identifier: "ABC-X", state: "Done" }] }),
		),
		false,
		"per-state todo concurrency prevents dispatch even when blockers are terminal",
	);
	assert.equal(priv(orchestrator).shouldDispatch(issue("ip-1", "ABC-IP", { state: "In Progress" })), true);
});

test("orchestrator retry scheduling covers continuation, exponential cap, slot exhaustion, and candidate disappearance", async () => {
	const orchestrator = configuredOrchestrator({ agent: { ...baseConfig().agent, maxRetryBackoffMs: 15_000, maxConcurrentAgents: 0 } });
	const entry = runningEntry(issue("normal-1", "ABC-1"));
	priv(orchestrator).state.running.set("normal-1", entry);
	priv(orchestrator).state.claimed.add("normal-1");

	await priv(orchestrator).onWorkerExit("normal-1", "normal");
	let retry = priv(orchestrator).state.retry_attempts.get("normal-1");
	assert.equal(retry.attempt, 1);
	assert.equal(retry.error, "continuation");
	assert.equal(retry.due_at_ms - performance.now() <= 1_100, true);
	clearTimeout(retry.timer_handle);

	priv(orchestrator).scheduleRetry("fail-1", "ABC-F", 3, "boom");
	retry = priv(orchestrator).state.retry_attempts.get("fail-1");
	assert.equal(retry.attempt, 3);
	assert.equal(retry.due_at_ms - performance.now() <= 15_100, true);
	clearTimeout(retry.timer_handle);

	const candidate = issue("slot-1", "ABC-S", { state: "In Progress" });
	priv(orchestrator).state.retry_attempts.set("slot-1", {
		issue_id: "slot-1",
		identifier: "ABC-S",
		attempt: 1,
		due_at_ms: performance.now(),
		timer_handle: setTimeout(() => {}, 1_000),
		error: null,
	});
	priv(orchestrator).state.claimed.add("slot-1");
	priv(orchestrator).tracker = { fetchCandidateIssues: async () => [candidate] };
	await priv(orchestrator).onRetryTimer("slot-1");
	retry = priv(orchestrator).state.retry_attempts.get("slot-1");
	assert.equal(retry.attempt, 2);
	assert.equal(retry.error, "no available orchestrator slots");
	clearTimeout(retry.timer_handle);

	priv(orchestrator).state.retry_attempts.set("gone-1", {
		issue_id: "gone-1",
		identifier: "ABC-G",
		attempt: 1,
		due_at_ms: performance.now(),
		timer_handle: setTimeout(() => {}, 1_000),
		error: null,
	});
	priv(orchestrator).state.claimed.add("gone-1");
	priv(orchestrator).tracker = { fetchCandidateIssues: async () => [] };
	await priv(orchestrator).onRetryTimer("gone-1");
	assert.equal(priv(orchestrator).state.claimed.has("gone-1"), false);
	assert.equal(priv(orchestrator).state.retry_attempts.has("gone-1"), false);
});

test("orchestrator queue snapshots retain recently changed issues and reload after worker exit", async () => {
	const orchestrator = configuredOrchestrator();
	const active = issue("jira-1", "ABC-1", { state: "In Progress" });
	const review = issue("jira-1", "ABC-1", { state: "Review", updated_at: "2026-01-01T00:05:00.000Z" });
	let candidates = [active];
	let candidateFetches = 0;
	const refreshedIds: string[][] = [];
	priv(orchestrator).tracker = {
		fetchCandidateIssues: async () => {
			candidateFetches++;
			return candidates;
		},
		fetchIssueStatesByIds: async (ids: string[]) => {
			refreshedIds.push(ids);
			return ids.includes("jira-1") ? [review] : [];
		},
		fetchIssuesByStates: async () => [],
	};

	let snapshot = await orchestrator.queueSnapshot();
	assert.equal(snapshot.eligible[0]?.issue.state, "In Progress");

	candidates = [];
	snapshot = await orchestrator.queueSnapshot();
	assert.equal(snapshot.recentlyChanged[0]?.issue.identifier, "ABC-1");
	assert.equal(snapshot.recentlyChanged[0]?.issue.state, "Review");
	assert.equal(snapshot.recentlyChanged[0]?.eligibility.reasons.some((reason) => reason.code === "inactive_state"), true);

	const entry = runningEntry(active);
	priv(orchestrator).state.running.set("jira-1", entry);
	await priv(orchestrator).onWorkerExit("jira-1", "normal");
	const retry = priv(orchestrator).state.retry_attempts.get("jira-1");
	if (retry) clearTimeout(retry.timer_handle);

	assert.equal(candidateFetches >= 3, true);
	assert.equal(refreshedIds.some((ids) => ids.includes("jira-1")), true);
	snapshot = await orchestrator.queueSnapshot();
	assert.equal(snapshot.recentlyChanged[0]?.issue.state, "Review");
});

test("orchestrator reconciliation updates active, stops non-active, cleans terminal, and keeps workers on refresh failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-reconcile-"));
	const cfg = baseConfig();
	cfg.workflowDir = cwd;
	cfg.workflowPath = join(cwd, "WORKFLOW.md");
	const orchestrator = configuredOrchestrator(cfg);
	const removed: string[] = [];
	const active = runningEntry(issue("active-1", "ABC-A", { state: "Todo" }));
	const nonActive = runningEntry(issue("hold-1", "ABC-H", { state: "In Progress" }), { workspace_path: join(cwd, "workspaces", "ABC-H") });
	const terminal = runningEntry(issue("done-1", "ABC-D", { state: "In Progress" }), { workspace_path: join(cwd, "workspaces", "ABC-D") });
	await priv(orchestrator).prepareRunArtifacts(nonActive, nonActive.workspace_path, "Hold prompt");
	await priv(orchestrator).prepareRunArtifacts(terminal, terminal.workspace_path, "Done prompt");
	priv(orchestrator).state.running.set("active-1", active);
	priv(orchestrator).state.running.set("hold-1", nonActive);
	priv(orchestrator).state.running.set("done-1", terminal);
	priv(orchestrator).state.claimed.add("active-1");
	priv(orchestrator).state.claimed.add("hold-1");
	priv(orchestrator).state.claimed.add("done-1");
	priv(orchestrator).workspace = { removeForIssue: async (identifier: string) => removed.push(identifier) };
	priv(orchestrator).tracker = {
		fetchIssueStatesByIds: async () => [
			issue("active-1", "ABC-A", { state: "In Progress" }),
			issue("hold-1", "ABC-H", { state: "Review" }),
			issue("done-1", "ABC-D", { state: "Done" }),
		],
	};

	await priv(orchestrator).reconcileRunningIssues();

	assert.equal(priv(orchestrator).state.running.get("active-1")?.issue.state, "In Progress");
	assert.equal(nonActive.abort.signal.aborted, true);
	assert.equal(terminal.abort.signal.aborted, true);
	assert.equal(priv(orchestrator).state.running.has("hold-1"), false);
	assert.equal(priv(orchestrator).state.running.has("done-1"), false);
	assert.deepEqual(removed, ["ABC-D"]);
	assert.equal(JSON.parse(await readFile(join(nonActive.artifact_path!, "result.json"), "utf8")).terminal_reason, "cancelled_by_reconciliation");
	assert.equal(JSON.parse(await readFile(join(terminal.artifact_path!, "result.json"), "utf8")).terminal_reason, "cancelled_by_reconciliation");

	const keep = runningEntry(issue("keep-1", "ABC-K", { state: "In Progress" }));
	priv(orchestrator).state.running.set("keep-1", keep);
	priv(orchestrator).tracker = { fetchIssueStatesByIds: async () => Promise.reject(new Error("network")) };
	await priv(orchestrator).reconcileRunningIssues();
	assert.equal(priv(orchestrator).state.running.has("keep-1"), true);
	assert.equal(keep.abort.signal.aborted, false);
});

test("invalid workflow reload keeps last good config and does not log success", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-reload-"));
	const logger = captureLogger();
	await import("node:fs/promises").then((fs) => fs.writeFile(join(cwd, "WORKFLOW.md"), "---\ntracker:\n  kind: beads\npolling:\n  interval_ms: 1234\n---\nTask"));
	const orchestrator = new SymphonyOrchestrator(cwd, undefined, logger);

	assert.equal(await priv(orchestrator).reload(true), true);
	assert.equal(priv(orchestrator).config.polling.intervalMs, 1234);
	await import("node:fs/promises").then((fs) => fs.writeFile(join(cwd, "WORKFLOW.md"), "---\ntracker:\n  command: bd\n---\nTask"));
	assert.equal(await priv(orchestrator).reload(false), false);

	assert.equal(priv(orchestrator).config.polling.intervalMs, 1234);
	assert.match(priv(orchestrator).reloadError, /tracker\.kind/);
	assert.equal(logger.entries.some((entry) => entry.message === "workflow change reloaded"), false);
	assert.equal(logger.entries.some((entry) => entry.message === "workflow reload failed"), true);
});

test("orchestrator issue snapshot includes recommended debug fields", () => {
	const orchestrator = configuredOrchestrator();
	const entry = runningEntry(issue("snap-1", "ABC-S"), {
		workspace_path: "/tmp/workspaces/ABC-S",
		retry_attempt: 2,
		last_error: "last boom",
		last_codex_event: "turn_failed",
		last_codex_timestamp: "2026-01-01T00:00:00.000Z",
		last_codex_message: "failed",
		recent_events: [{ at: "2026-01-01T00:00:00.000Z", event: "turn_failed", message: "failed" }],
	});
	priv(orchestrator).state.running.set("snap-1", entry);

	const snapshot = orchestrator.issueSnapshot("ABC-S") as any;

	assert.equal(snapshot.issue_identifier, "ABC-S");
	assert.deepEqual(snapshot.workspace, { path: "/tmp/workspaces/ABC-S" });
	assert.deepEqual(snapshot.attempts, { restart_count: 2, current_retry_attempt: 2 });
	assert.deepEqual(snapshot.logs, { codex_session_logs: [] });
	assert.equal(snapshot.terminal_reason, null);
	assert.deepEqual(snapshot.recent_events, [{ at: "2026-01-01T00:00:00.000Z", event: "turn_failed", message: "failed" }]);
	assert.equal(snapshot.last_error, "last boom");
	assert.deepEqual(snapshot.tracked, {});
});

test("orchestrator tracks a bounded recent event ring buffer", () => {
	const orchestrator = configuredOrchestrator();
	const entry = runningEntry(issue("ring-1", "ABC-R"));
	priv(orchestrator).state.running.set("ring-1", entry);

	for (let i = 0; i < 55; i++) {
		priv(orchestrator).onCodexEvent("ring-1", { event: `event_${i}`, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, message: `message ${i}` });
	}

	assert.equal(entry.recent_events.length, 50);
	assert.equal(entry.recent_events[0]?.event, "event_5");
	assert.equal(entry.recent_events.at(-1)?.event, "event_54");
	const snapshot = orchestrator.issueSnapshot("ABC-R") as any;
	assert.equal(snapshot.recent_events.length, 50);
	assert.equal(snapshot.running.recent_events.length, 50);
});

test("after_run runs after prompt failures once workspace exists", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-after-run-"));
	const cfg = baseConfig();
	cfg.workflowDir = cwd;
	cfg.workflowPath = join(cwd, "WORKFLOW.md");
	cfg.workspace.root = join(cwd, "workspaces");
	cfg.hooks.afterRun = "echo after >> ../after.log";
	const orchestrator = configuredOrchestrator(cfg);
	priv(orchestrator).workflow = { path: cfg.workflowPath, config: {}, prompt_template: "{{ missing.value }}" };
	const entry = runningEntry(issue("prompt-1", "ABC-P"));

	await assert.rejects(() => priv(orchestrator).runAgentAttempt(entry), /missing|undefined|error/i);

	assert.equal(await readFile(join(cfg.workspace.root, "after.log"), "utf8"), "after\n");
});

test("shutdown suppresses retry scheduling while ordinary failures still retry", async () => {
	const orchestrator = configuredOrchestrator();
	const stopped = runningEntry(issue("stop-1", "ABC-X"));
	priv(orchestrator).state.running.set("stop-1", stopped);
	priv(orchestrator).stopping = true;

	await priv(orchestrator).onWorkerExit("stop-1", "abnormal", new Error("turn_cancelled"));
	assert.equal(priv(orchestrator).state.retry_attempts.has("stop-1"), false);

	const running = runningEntry(issue("retry-1", "ABC-R"));
	priv(orchestrator).state.running.set("retry-1", running);
	priv(orchestrator).stopping = false;
	await priv(orchestrator).onWorkerExit("retry-1", "abnormal", new Error("boom"));
	const retry = priv(orchestrator).state.retry_attempts.get("retry-1");
	assert.equal(retry.error, "boom");
	clearTimeout(retry.timer_handle);
});

test("token accounting ignores delta-style usage and counts absolute totals once", () => {
	const orchestrator = configuredOrchestrator();
	const entry = runningEntry(issue("usage-1", "ABC-U"));
	priv(orchestrator).state.running.set("usage-1", entry);

	priv(orchestrator).onCodexEvent("usage-1", { event: "agent_message", timestamp: "2026-01-01T00:00:00.000Z", usage: { last_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
	assert.deepEqual(priv(orchestrator).state.codex_totals, { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 });

	priv(orchestrator).onCodexEvent("usage-1", { event: "thread_tokenUsage_updated", timestamp: "2026-01-01T00:00:01.000Z", usage: { total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
	priv(orchestrator).onCodexEvent("usage-1", { event: "thread_tokenUsage_updated", timestamp: "2026-01-01T00:00:02.000Z", usage: { total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
	assert.equal(priv(orchestrator).state.codex_totals.input_tokens, 10);
	assert.equal(priv(orchestrator).state.codex_totals.output_tokens, 4);
	assert.equal(priv(orchestrator).state.codex_totals.total_tokens, 14);
});

test("run artifacts write prompt, events, success/failure/cancellation results, and redact secrets", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-artifacts-"));
	const cfg = baseConfig();
	cfg.workflowDir = cwd;
	cfg.workflowPath = join(cwd, "WORKFLOW.md");
	cfg.tracker.apiKey = "sk-testsecret123456";
	cfg.tracker.jiraApiToken = "jira-secret-token";
	const orchestrator = configuredOrchestrator(cfg);

	const success = runningEntry(issue("art-1", "ABC/ART"), { started_at: "2026-01-02T03:04:05.000Z", workspace_path: join(cwd, "workspaces", "ABC_ART") });
	priv(orchestrator).state.running.set("art-1", success);
	await priv(orchestrator).prepareRunArtifacts(success, success.workspace_path, "Prompt with sk-testsecret123456 and jira-secret-token");
	priv(orchestrator).onCodexEvent("art-1", { event: "turn_completed", timestamp: "2026-01-02T03:04:06.000Z", message: "TOKEN=sk-testsecret123456" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await priv(orchestrator).finishRunArtifact(success, "succeeded", "succeeded");
	assert.ok(success.artifact_path);
	const successArtifactPath = success.artifact_path;

	assert.match(successArtifactPath, /ABC_ART_attempt-0$/);
	assert.equal(await readFile(join(successArtifactPath, "prompt.md"), "utf8"), "Prompt with [redacted] and [redacted]");
	assert.match(await readFile(join(successArtifactPath, "events.jsonl"), "utf8"), /\[redacted\]/);
	const successResult = JSON.parse(await readFile(join(successArtifactPath, "result.json"), "utf8"));
	assert.equal(successResult.status, "succeeded");
	assert.equal(successResult.terminal_reason, "succeeded");
	const snapshot = orchestrator.issueSnapshot("ABC/ART") as any;
	assert.equal(snapshot.artifacts.events, join(successArtifactPath, "events.jsonl"));
	assert.deepEqual(snapshot.logs.codex_session_logs, [{ label: "Codex events", path: join(successArtifactPath, "events.jsonl"), url: `file://${join(successArtifactPath, "events.jsonl")}` }]);

	const failed = runningEntry(issue("art-2", "ABC-F"), { workspace_path: join(cwd, "workspaces", "ABC-F") });
	await priv(orchestrator).prepareRunArtifacts(failed, failed.workspace_path, "Failure prompt");
	await priv(orchestrator).finishRunArtifact(failed, "failed", "failed", new Error("boom sk-testsecret123456"));
	assert.ok(failed.artifact_path);
	const failedResult = await readFile(join(failed.artifact_path, "result.json"), "utf8");
	assert.match(failedResult, /"status": "failed"/);
	assert.match(failedResult, /"terminal_reason": "failed"/);
	assert.doesNotMatch(failedResult, /sk-testsecret123456/);

	const cancelled = runningEntry(issue("art-3", "ABC-C"), { workspace_path: join(cwd, "workspaces", "ABC-C") });
	cancelled.abort.abort();
	await priv(orchestrator).prepareRunArtifacts(cancelled, cancelled.workspace_path, "Cancel prompt");
	await priv(orchestrator).finishRunArtifact(cancelled, "cancelled", "cancelled", new Error("turn_cancelled"));
	assert.ok(cancelled.artifact_path);
	const cancelledResult = JSON.parse(await readFile(join(cancelled.artifact_path, "result.json"), "utf8"));
	assert.equal(cancelledResult.status, "cancelled");
	assert.equal(cancelledResult.terminal_reason, "cancelled");

	const timeout = runningEntry(issue("art-4", "ABC-T"), { workspace_path: join(cwd, "workspaces", "ABC-T") });
	priv(orchestrator).state.running.set("art-4", timeout);
	await priv(orchestrator).prepareRunArtifacts(timeout, timeout.workspace_path, "Timeout prompt");
	await priv(orchestrator).onWorkerExit("art-4", "abnormal", new Error("turn_timeout: turn turn_1 timed out"));
	const timeoutRetry = priv(orchestrator).state.retry_attempts.get("art-4");
	clearTimeout(timeoutRetry.timer_handle);
	assert.equal(JSON.parse(await readFile(join(timeout.artifact_path!, "result.json"), "utf8")).terminal_reason, "timed_out");
	assert.equal(timeoutRetry.terminal_reason, "timed_out");

	const stalled = runningEntry(issue("art-5", "ABC-ST"), { workspace_path: join(cwd, "workspaces", "ABC-ST"), abort_reason: "stalled" });
	stalled.abort.abort();
	priv(orchestrator).state.running.set("art-5", stalled);
	await priv(orchestrator).prepareRunArtifacts(stalled, stalled.workspace_path, "Stall prompt");
	await priv(orchestrator).onWorkerExit("art-5", "abnormal", new Error("turn_cancelled"));
	const stalledRetry = priv(orchestrator).state.retry_attempts.get("art-5");
	clearTimeout(stalledRetry.timer_handle);
	assert.equal(JSON.parse(await readFile(join(stalled.artifact_path!, "result.json"), "utf8")).terminal_reason, "stalled");
	assert.equal(stalledRetry.terminal_reason, "stalled");
});

test("orchestrator stall detection aborts only when enabled", () => {
	const orchestrator = configuredOrchestrator({ codex: { ...baseConfig().codex, stallTimeoutMs: 10 } });
	const stale = runningEntry(issue("stale-1", "ABC-S"), { started_at: new Date(Date.now() - 60_000).toISOString() });
	priv(orchestrator).state.running.set("stale-1", stale);

	priv(orchestrator).reconcileStalledRuns();
	assert.equal(stale.abort.signal.aborted, true);

	const disabled = configuredOrchestrator({ codex: { ...baseConfig().codex, stallTimeoutMs: 0 } });
	const staleButAllowed = runningEntry(issue("stale-2", "ABC-T"), { started_at: new Date(Date.now() - 60_000).toISOString() });
	priv(disabled).state.running.set("stale-2", staleButAllowed);
	priv(disabled).reconcileStalledRuns();
	assert.equal(staleButAllowed.abort.signal.aborted, false);
});

function configuredOrchestrator(overrides: Partial<SymphonyConfig> = {}): SymphonyOrchestrator {
	const orchestrator = new SymphonyOrchestrator(process.cwd(), undefined, logger);
	const cfg = { ...baseConfig(), ...overrides } as SymphonyConfig;
	priv(orchestrator).config = cfg;
	priv(orchestrator).workflow = { path: cfg.workflowPath, config: {}, prompt_template: "Task" };
	return orchestrator;
}

function baseConfig(): SymphonyConfig {
	return {
		workflowPath: join(process.cwd(), "WORKFLOW.md"),
		workflowDir: process.cwd(),
		tracker: {
			kind: "beads",
			endpoint: "",
			apiKey: null,
			projectSlug: "",
			jiraEmail: null,
			jiraApiToken: null,
			jiraProjectKey: "",
			jiraJql: null,
			beadsCommand: "bd",
			beadsReadyCommand: "bd ready --json",
			activeStates: ["Todo", "In Progress"],
			terminalStates: ["Done", "Canceled"],
		},
		polling: { intervalMs: 30_000 },
		workspace: { root: join(process.cwd(), "workspaces") },
		hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
		agent: { maxConcurrentAgents: 10, maxTurns: 20, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command: "codex app-server", readTimeoutMs: 5_000, turnTimeoutMs: 3_600_000, stallTimeoutMs: 300_000 },
		pi: { command: "npx --yes --package pi-app-server@2.0.0 pi-server", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 5_000, turnTimeoutMs: 3_600_000, stallTimeoutMs: 300_000 },
		server: {},
	};
}

function issue(id: string, identifier: string, overrides: Partial<Issue> = {}): Issue {
	return {
		id,
		identifier,
		title: `Issue ${identifier}`,
		description: null,
		priority: null,
		state: "Todo",
		branch_name: null,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: null,
		updated_at: null,
		...overrides,
	};
}

function runningEntry(entryIssue: Issue, overrides: Partial<RunningEntry> = {}): RunningEntry {
	const abort = new AbortController();
	return {
		issue: entryIssue,
		identifier: entryIssue.identifier,
		started_at: new Date().toISOString(),
		workspace_path: null,
		artifact_path: null,
		retry_attempt: null,
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
		...overrides,
	};
}

function captureLogger(): Logger & { entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> } {
	const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
	return {
		entries,
		info: (message, fields) => entries.push({ level: "info", message, fields }),
		warn: (message, fields) => entries.push({ level: "warn", message, fields }),
		error: (message, fields) => entries.push({ level: "error", message, fields }),
		debug: (message, fields) => entries.push({ level: "debug", message, fields }),
	};
}

function priv(orchestrator: SymphonyOrchestrator): any {
	return orchestrator as any;
}
