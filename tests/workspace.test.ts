import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { assertInsideRoot, WorkspaceManager } from "../src/workspace.js";
import type { Logger, SymphonyConfig } from "../src/types.js";

test("workspace manager sanitizes identifiers and enforces root containment", async () => {
	const { manager, root } = await setup();

	assert.equal(manager.sanitizeIdentifier("ABC/../evil ticket!*"), "ABC_.._evil_ticket__");
	assert.equal(manager.workspacePathForIdentifier("ABC/../evil ticket!*"), join(root, "ABC_.._evil_ticket__"));
	assert.throws(() => assertInsideRoot(root, join(root, "..", "outside")), /escapes workspace root/);
});

test("workspace hook logs include issue context when provided", async () => {
	const logger = captureLogger();
	const { manager } = await setup({ logger, hooks: { afterCreate: "true" } });

	await manager.createForIssue("ABC-1", undefined, { issue_id: "issue-1", issue_identifier: "ABC-1" });

	assert.equal(logger.entries.some((entry) => entry.message === "hook started" && entry.fields?.issue_id === "issue-1" && entry.fields?.issue_identifier === "ABC-1"), true);
	assert.equal(logger.entries.some((entry) => entry.message === "hook completed" && entry.fields?.issue_id === "issue-1" && entry.fields?.issue_identifier === "ABC-1"), true);
});

test("workspace creation creates, reuses, and runs after_create only on first creation", async () => {
	const { manager, root } = await setup({ hooks: { afterCreate: "echo created >> hook.log" } });

	const first = await manager.createForIssue("ABC-1");
	const second = await manager.createForIssue("ABC-1");

	assert.equal(first.created_now, true);
	assert.equal(second.created_now, false);
	assert.equal(await readFile(join(root, "ABC-1", "hook.log"), "utf8"), "created\n");
});

test("workspace creation fails safely when an existing path is not a directory", async () => {
	const { manager, root } = await setup();
	await writeFile(join(root, "ABC-1"), "not a directory");

	await assert.rejects(() => manager.createForIssue("ABC-1"), /not a directory/);
});

test("after_create failure and timeout abort workspace creation", async () => {
	const failing = await setup({ hooks: { afterCreate: "echo nope >&2; exit 3" } });
	await assert.rejects(() => failing.manager.createForIssue("ABC-1"), /hook after_create exited 3/);

	const timingOut = await setup({ hooks: { afterCreate: "sleep 1", timeoutMs: 20 } });
	await assert.rejects(() => timingOut.manager.createForIssue("ABC-2"), /hook timeout after 20ms/);
});

test("before_run failure aborts while after_run and before_remove failures are ignored", async () => {
	const { manager, root } = await setup({
		hooks: {
			beforeRun: "echo before >&2; exit 4",
			afterRun: "echo after >&2; exit 5",
			beforeRemove: "echo remove >&2; exit 6",
		},
	});
	const workspace = await manager.createForIssue("ABC-1");

	await assert.rejects(() => manager.runBeforeRun(workspace.path), /hook before_run exited 4/);
	await manager.runAfterRun(workspace.path);
	await manager.removeForIssue("ABC-1");
	await assert.rejects(() => stat(join(root, "ABC-1")), /ENOENT/);
});

test("before_remove runs only for existing workspace directories", async () => {
	const { manager, root, logger } = await setup({ hooks: { beforeRemove: "echo remove >> ../remove.log; exit 6" } });

	await manager.removeForIssue("MISSING-1");
	await assert.rejects(() => access(join(root, "remove.log")), /ENOENT/);

	await writeFile(join(root, "FILE-1"), "not a directory");
	await manager.removeForIssue("FILE-1");
	await assert.rejects(() => access(join(root, "FILE-1")), /ENOENT/);
	assert.equal((logger as ReturnType<typeof captureLogger>).entries.some((entry) => entry.message === "before_remove skipped for non-directory workspace path"), true);

	await manager.createForIssue("ABC-1");
	await manager.removeForIssue("ABC-1");
	assert.equal(await readFile(join(root, "remove.log"), "utf8"), "remove\n");
});

test("hook failure logs are truncated and redact obvious secrets", async () => {
	const logger = captureLogger();
	const secret = "LINEAR_API_KEY=sk-abcdefghijklmnopqrstuvwxyz EXTRA_SECRET=super-secret-value";
	const { manager } = await setup({ logger, hooks: { beforeRun: `python3 - <<'PY'\nprint('${secret}' * 1000)\nraise SystemExit(2)\nPY` } });
	const workspace = await manager.createForIssue("ABC-1");

	await assert.rejects(() => manager.runBeforeRun(workspace.path), /hook before_run exited 2/);

	const combined = logger.entries.map((entry) => JSON.stringify(entry)).join("\n");
	assert.equal(combined.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
	assert.equal(combined.includes("super-secret-value"), false);
	assert.equal(combined.length < 5_000, true);
	assert.match(combined, /\[redacted\]/);
});

async function setup(options: { hooks?: Partial<SymphonyConfig["hooks"]>; logger?: Logger } = {}): Promise<{ manager: WorkspaceManager; root: string; logger: Logger }> {
	const root = await mkdtemp(join(tmpdir(), "pi-symphony-workspaces-"));
	const logger = options.logger ?? captureLogger();
	const config: SymphonyConfig = {
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
			activeStates: ["open"],
			terminalStates: ["closed"],
		},
		polling: { intervalMs: 30_000 },
		workspace: { root },
		hooks: {
			afterCreate: null,
			beforeRun: null,
			afterRun: null,
			beforeRemove: null,
			timeoutMs: 60_000,
			...options.hooks,
		},
		agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command: "codex app-server", readTimeoutMs: 5_000, turnTimeoutMs: 3_600_000, stallTimeoutMs: 300_000 },
		pi: { command: "pi --mode rpc", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 5_000, turnTimeoutMs: 3_600_000, stallTimeoutMs: 300_000 },
		server: {},
	};
	return { root, logger, manager: new WorkspaceManager(() => config, logger) };
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
