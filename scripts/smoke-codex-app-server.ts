#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../src/codex.js";
import { createConsoleLogger } from "../src/logger.js";
import type { CodexRuntimeEvent, Issue, SymphonyConfig } from "../src/types.js";

const codex = process.env.CODEX_BIN ?? "codex";
if (spawnSync(codex, ["--version"], { encoding: "utf8" }).error) {
	console.log(`[skip] codex binary not found (${codex}); install Codex CLI or set CODEX_BIN to run this smoke.`);
	process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "pi-symphony-real-codex-"));
const workspace = join(root, "SMOKE-1");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "README.md"), "Temporary pi-symphony Codex smoke workspace.\n", "utf8");

const command = `${shellQuote(codex)} app-server`;
const events: CodexRuntimeEvent[] = [];
try {
	const client = new CodexAppServerClient(config(root, command), createConsoleLogger("symphony-smoke"));
	await client.runWorker({
		workspacePath: workspace,
		issue: issue(),
		prompt: "Reply with OK and do not modify files.",
		continuationPrompts: [],
		onEvent: (event) => events.push(event),
	});
	if (!events.some((event) => event.event === "session_started")) throw new Error("real Codex smoke did not observe session_started");
	if (!events.some((event) => event.event === "turn_completed")) throw new Error("real Codex smoke did not observe turn_completed");
	console.log(`[ok] real Codex app-server completed a minimal turn in ${workspace}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (/api key|auth|login|not authenticated|model|provider/i.test(message)) {
		console.log(`[skip] codex is installed but not ready for a real model-backed smoke: ${message}`);
		process.exit(0);
	}
	throw error;
} finally {
	await rm(root, { recursive: true, force: true });
}

function config(root: string, command: string): SymphonyConfig {
	return {
		workflowPath: join(root, "WORKFLOW.md"),
		workflowDir: root,
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
			activeStates: ["open", "in_progress"],
			terminalStates: ["closed"],
		},
		polling: { intervalMs: 30_000 },
		workspace: { root },
		hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 10_000 },
		agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 30_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command, approvalPolicy: "never", readTimeoutMs: 5_000, turnTimeoutMs: 30_000, stallTimeoutMs: 30_000 },
		pi: { command: "pi --mode rpc", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 5_000, turnTimeoutMs: 30_000, stallTimeoutMs: 30_000 },
		server: {},
	};
}

function issue(): Issue {
	return {
		id: "SMOKE-1",
		identifier: "SMOKE-1",
		title: "Codex smoke",
		description: null,
		priority: null,
		state: "open",
		branch_name: null,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: null,
		updated_at: null,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
