import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../src/codex.js";
import { createConsoleLogger } from "../src/logger.js";
import type { CodexRuntimeEvent, Issue, SymphonyConfig } from "../src/types.js";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

const fakeServerSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const scenario = process.argv[2] || 'success';
const logPath = process.env.FAKE_CODEX_LOG;
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function log(message) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + '\n'); }
if (scenario === 'exit') process.exit(7);
process.stderr.write('diagnostic stderr only\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (scenario === 'read-timeout' && msg.method === 'initialize') return;
  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake' } });
  else if (msg.method === 'initialized') {}
  else if (msg.method === 'thread/start') send({ id: msg.id, result: { thread: { id: 'thr_1' } } });
  else if (msg.method === 'thread/name/set') send({ id: msg.id, result: {} });
  else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [], error: null } } });
    if (scenario === 'turn-timeout') return;
    setTimeout(() => {
      send({ method: 'turn/started', params: { turn: { id: 'turn_1', status: 'inProgress' } } });
      send({ method: 'thread/tokenUsage/updated', params: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, rate_limits: { primary: 'ok' } } });
      if (scenario === 'exit-during-turn') {
        process.exit(9);
      } else if (scenario === 'user-input') {
        send({ id: 99, method: 'tool/requestUserInput', params: { threadId: 'thr_1', turnId: 'turn_1', questions: [{ text: 'Need input?' }] } });
      } else if (scenario === 'unsupported-request') {
        send({ id: 100, method: 'tool/unknown', params: { threadId: 'thr_1', turnId: 'turn_1' } });
        setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed', error: null } } }), 5);
      } else if (scenario === 'approval-request') {
        send({ id: 101, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', command: 'echo ok' } });
        send({ id: 102, method: 'item/fileChange/requestApproval', params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2' } });
        setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed', error: null } } }), 5);
      } else if (scenario === 'linear-tool') {
        send({ id: 103, method: 'item/tool/call', params: { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1', tool: 'linear_graphql', arguments: { query: 'query { viewer { id } }', variables: {} } } });
        setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed', error: null } } }), 50);
      } else if (scenario === 'failed') {
        send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'failed', error: { message: 'model failed' } } } });
      } else if (scenario === 'interrupted') {
        send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'interrupted', error: null } } });
      } else {
        send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed', error: null } } });
      }
    }, 5);
  }
});
`;

test("Codex client completes fake app-server turn and passes protocol config", async () => {
	const { workspace, command, logPath } = await setupFake("success");
	const events: CodexRuntimeEvent[] = [];
	const cfg = config(workspace, command);
	cfg.codex.approvalPolicy = "never";
	cfg.codex.threadSandbox = "workspaceWrite";
	cfg.codex.turnSandboxPolicy = { type: "workspaceWrite", writableRoots: [workspace], networkAccess: true };
	const client = new CodexAppServerClient(cfg, createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	assert.equal(events.some((event) => event.event === "session_process_started"), true);
	assert.equal(events.some((event) => event.event === "session_started" && event.session_id === "thr_1-turn_1"), true);
	assert.equal(events.some((event) => event.event === "turn_completed"), true);
	assert.equal(events.some((event) => event.event === "thread_tokenUsage_updated" && event.usage), true);
	const messages = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(messages[0].method, "initialize");
	assert.equal(messages[1].method, "initialized");
	const threadStart = messages.find((message) => message.method === "thread/start");
	const turnStart = messages.find((message) => message.method === "turn/start");
	const nameSet = messages.find((message) => message.method === "thread/name/set");
	assert.equal(threadStart.params.cwd, workspace);
	assert.equal(threadStart.params.approvalPolicy, "never");
	assert.equal(threadStart.params.sandbox, "workspaceWrite");
	assert.equal(threadStart.params.dynamic_tools, undefined);
	assert.equal(turnStart.params.cwd, workspace);
	assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Do work" }]);
	assert.deepEqual(turnStart.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [workspace], networkAccess: true });
	assert.deepEqual(nameSet.params, { threadId: "thr_1", name: "ABC-1: Test issue" });
});

test("Codex client maps turn failure, interruption, process exit, read timeout, and turn timeout", async () => {
	await assertScenarioRejects("failed", /turn_failed: model failed/);
	await assertScenarioRejects("interrupted", /turn_cancelled/);
	await assertScenarioRejects("exit", /port_exit/);
	await assertScenarioRejects("exit-during-turn", /port_exit/);
	await assertScenarioRejects("read-timeout", /response_timeout: initialize/);
	await assertScenarioRejects("turn-timeout", /turn_timeout: turn turn_1/);
});

test("Codex client fails user-input-required server requests without waiting for timeout", async () => {
	const started = Date.now();
	await assertScenarioRejects("user-input", /turn_input_required/);
	assert.equal(Date.now() - started < 900, true);
});

test("Codex client handles AbortSignal shutdown without unhandled child process errors", async () => {
	const { workspace, command } = await setupFake("turn-timeout");
	const client = new CodexAppServerClient(config(workspace, command, { readTimeoutMs: 1_000, turnTimeoutMs: 1_000 }), createConsoleLogger("test"));
	const abort = new AbortController();
	const run = client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: () => {}, signal: abort.signal });

	setTimeout(() => abort.abort(), 25).unref();

	await assert.rejects(() => run, /turn_cancelled/);
});

test("Codex client auto-approves high-trust approval requests", async () => {
	const { workspace, command, logPath } = await setupFake("approval-request");
	const events: CodexRuntimeEvent[] = [];
	const client = new CodexAppServerClient(config(workspace, command), createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	const messages = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(messages.find((message) => message.id === 101).result, { decision: "accept" });
	assert.deepEqual(messages.find((message) => message.id === 102).result, { decision: "accept" });
	assert.equal(events.some((event) => event.event === "approval_auto_approved"), true);
});

test("Codex client advertises linear_graphql for Linear sessions and handles dynamic tool calls", async () => {
	const { workspace, command, logPath } = await setupFake("linear-tool");
	const cfg = config(workspace, command);
	cfg.tracker.kind = "linear";
	cfg.tracker.apiKey = "linear-token";
	cfg.tracker.endpoint = "https://linear.example/graphql";
	const requests: any[] = [];
	globalThis.fetch = (async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		return new Response(JSON.stringify({ data: { viewer: { id: "me" } } }), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	const client = new CodexAppServerClient(cfg, createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: () => {} });

	const messages = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const threadStart = messages.find((message) => message.method === "thread/start");
	const response = messages.find((message) => message.id === 103);
	assert.equal(threadStart.params.dynamic_tools[0].name, "linear_graphql");
	assert.equal(threadStart.params.dynamic_tools[0].inputSchema.required[0], "query");
	assert.deepEqual(requests[0], { query: "query { viewer { id } }", variables: {} });
	assert.equal(response.result.success, true);
	assert.match(response.result.contentItems[0].text, /viewer/);
});

test("Codex client rejects unsupported server requests without stalling the turn", async () => {
	const { workspace, command, logPath } = await setupFake("unsupported-request");
	const client = new CodexAppServerClient(config(workspace, command), createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: () => {} });

	const messages = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const response = messages.find((message) => message.id === 100);
	assert.match(response.error.message, /unsupported_tool_call: tool\/unknown/);
});

async function assertScenarioRejects(scenario: string, pattern: RegExp): Promise<void> {
	const { workspace, command } = await setupFake(scenario);
	const client = new CodexAppServerClient(config(workspace, command, { readTimeoutMs: 500, turnTimeoutMs: 750 }), createConsoleLogger("test"));
	await assert.rejects(
		() => client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: () => {} }),
		pattern,
	);
}

async function setupFake(scenario: string): Promise<{ workspace: string; command: string; logPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-symphony-codex-root-"));
	const workspace = join(root, "ABC-1");
	await writeFile(join(root, "placeholder"), "");
	await import("node:fs/promises").then((fs) => fs.mkdir(workspace, { recursive: true }));
	const fake = join(root, "fake-codex.cjs");
	const logPath = join(root, "protocol.jsonl");
	await writeFile(fake, fakeServerSource);
	await chmod(fake, 0o755);
	return { workspace, logPath, command: `FAKE_CODEX_LOG=${shellQuote(logPath)} node ${shellQuote(fake)} ${shellQuote(scenario)}` };
}

function config(workspace: string, command: string, overrides: { readTimeoutMs?: number; turnTimeoutMs?: number } = {}): SymphonyConfig {
	const root = workspace.replace(/\/ABC-1$/, "");
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
			activeStates: ["open"],
			terminalStates: ["closed"],
		},
		polling: { intervalMs: 30_000 },
		workspace: { root },
		hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
		agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command, readTimeoutMs: overrides.readTimeoutMs ?? 1_000, turnTimeoutMs: overrides.turnTimeoutMs ?? 1_000, stallTimeoutMs: 300_000 },
		pi: { command: "npx --yes --package pi-app-server@2.0.0 pi-server", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 1_000, turnTimeoutMs: 1_000, stallTimeoutMs: 300_000 },
		server: {},
	};
}

function issue(): Issue {
	return {
		id: "ABC-1",
		identifier: "ABC-1",
		title: "Test issue",
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
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
