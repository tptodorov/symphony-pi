#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsoleLogger } from "../src/logger.js";
import { JiraTrackerClient } from "../src/tracker.js";
import type { SymphonyConfig } from "../src/types.js";

if (!isTruthy(process.env.PI_SYMPHONY_LIVE_JIRA)) {
	console.log("[skip] Jira live smoke is opt-in; set PI_SYMPHONY_LIVE_JIRA=1 with JIRA_EMAIL, JIRA_API_TOKEN, JIRA_ENDPOINT, and JIRA_PROJECT_KEY or JIRA_JQL.");
	process.exit(0);
}

const email = process.env.JIRA_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;
const endpoint = process.env.JIRA_ENDPOINT;
const projectKey = process.env.JIRA_PROJECT_KEY ?? "";
const jql = process.env.JIRA_JQL ?? null;
if (!email || !apiToken || !endpoint || (!projectKey && !jql)) {
	console.log("[skip] Jira live smoke requires JIRA_EMAIL, JIRA_API_TOKEN, JIRA_ENDPOINT, and JIRA_PROJECT_KEY or JIRA_JQL.");
	process.exit(0);
}

const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-jira-live-"));
try {
	await writeFile(join(cwd, "WORKFLOW.md"), "Jira live smoke\n", "utf8");
	const activeStates = csv(process.env.JIRA_ACTIVE_STATES, ["To Do", "In Progress"]);
	const terminalStates = csv(process.env.JIRA_TERMINAL_STATES, ["Done", "Canceled"]);
	const config = baseConfig(cwd, endpoint, email, apiToken, projectKey, jql, activeStates, terminalStates);
	const tracker = new JiraTrackerClient(() => config, createConsoleLogger("jira-live-smoke"));

	const candidates = await tracker.fetchCandidateIssues();
	const emptyTerminal = await tracker.fetchIssuesByStates([]);
	if (emptyTerminal.length !== 0) throw new Error("Jira fetchIssuesByStates([]) should return [] without querying");
	const terminal = await tracker.fetchIssuesByStates(terminalStates);
	const issue = candidates[0] ?? terminal[0];
	if (!issue) {
		console.log("[skip] Jira live smoke connected but found no active/terminal issues for the supplied project/JQL; create one safe test issue to verify state refresh.");
		process.exit(0);
	}
	const refreshed = await tracker.fetchIssueStatesByIds([issue.identifier]);
	if (!refreshed.some((row) => row.identifier === issue.identifier)) throw new Error(`Jira state refresh did not return ${issue.identifier}`);
	console.log(`[ok] Jira live smoke: candidates=${candidates.length} terminal=${terminal.length} refreshed=${issue.identifier} page_size=1`);
} finally {
	await rm(cwd, { recursive: true, force: true });
}

function baseConfig(
	cwd: string,
	endpoint: string,
	email: string,
	apiToken: string,
	projectKey: string,
	jql: string | null,
	activeStates: string[],
	terminalStates: string[],
): SymphonyConfig {
	return {
		workflowPath: join(cwd, "WORKFLOW.md"),
		workflowDir: cwd,
		tracker: {
			kind: "jira",
			endpoint,
			apiKey: null,
			projectSlug: "",
			jiraEmail: email,
			jiraApiToken: apiToken,
			jiraProjectKey: projectKey,
			jiraJql: jql,
			jiraPageSize: 1,
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
