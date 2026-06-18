#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsoleLogger } from "../src/logger.js";
import { LinearTrackerClient } from "../src/tracker.js";
import type { SymphonyConfig } from "../src/types.js";

if (!isTruthy(process.env.PI_SYMPHONY_LIVE_LINEAR)) {
	console.log("[skip] Linear live smoke is opt-in; set PI_SYMPHONY_LIVE_LINEAR=1 with LINEAR_API_KEY and LINEAR_PROJECT_SLUG.");
	process.exit(0);
}

const apiKey = process.env.LINEAR_API_KEY;
const projectSlug = process.env.LINEAR_PROJECT_SLUG ?? process.env.PI_SYMPHONY_LINEAR_PROJECT_SLUG;
if (!apiKey || !projectSlug) {
	console.log("[skip] Linear live smoke requires LINEAR_API_KEY and LINEAR_PROJECT_SLUG (or PI_SYMPHONY_LINEAR_PROJECT_SLUG).");
	process.exit(0);
}

const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-linear-live-"));
try {
	await writeFile(join(cwd, "WORKFLOW.md"), "Linear live smoke\n", "utf8");
	const activeStates = csv(process.env.LINEAR_ACTIVE_STATES, ["Todo", "In Progress"]);
	const terminalStates = csv(process.env.LINEAR_TERMINAL_STATES, ["Done", "Closed", "Canceled", "Cancelled"]);
	const config = baseConfig(cwd, apiKey, projectSlug, activeStates, terminalStates);
	const tracker = new LinearTrackerClient(() => config, createConsoleLogger("linear-live-smoke"));

	const candidates = await tracker.fetchCandidateIssues();
	const emptyTerminal = await tracker.fetchIssuesByStates([]);
	if (emptyTerminal.length !== 0) throw new Error("Linear fetchIssuesByStates([]) should return [] without querying");
	const terminal = await tracker.fetchIssuesByStates(terminalStates);
	const issue = candidates[0] ?? terminal[0];
	if (!issue) {
		console.log(`[skip] Linear live smoke connected but found no active/terminal issues in project ${projectSlug}; create one safe test issue to verify state refresh.`);
		process.exit(0);
	}
	const refreshed = await tracker.fetchIssueStatesByIds([issue.id]);
	if (!refreshed.some((row) => row.id === issue.id)) throw new Error(`Linear state refresh did not return ${issue.id}`);
	console.log(`[ok] Linear live smoke: candidates=${candidates.length} terminal=${terminal.length} refreshed=${issue.identifier}`);
} finally {
	await rm(cwd, { recursive: true, force: true });
}

function baseConfig(cwd: string, apiKey: string, projectSlug: string, activeStates: string[], terminalStates: string[]): SymphonyConfig {
	return {
		workflowPath: join(cwd, "WORKFLOW.md"),
		workflowDir: cwd,
		tracker: {
			kind: "linear",
			endpoint: process.env.LINEAR_ENDPOINT ?? "https://api.linear.app/graphql",
			apiKey,
			projectSlug,
			jiraEmail: null,
			jiraApiToken: null,
			jiraProjectKey: "",
			jiraJql: null,
			beadsCommand: "bd",
			beadsReadyCommand: "bd ready --json",
			activeStates,
			terminalStates,
		},
		polling: { intervalMs: 30_000 },
		workspace: { root: join(cwd, "workspaces") },
		hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 10_000 },
		agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 30_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command: "codex app-server", readTimeoutMs: 5_000, turnTimeoutMs: 30_000, stallTimeoutMs: 30_000 },
		pi: { command: "npx --yes --package pi-app-server@2.0.0 pi-server", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 5_000, turnTimeoutMs: 30_000, stallTimeoutMs: 30_000 },
		server: {},
	};
}

function csv(value: string | undefined, fallback: string[]): string[] {
	return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? fallback;
}

function isTruthy(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}
