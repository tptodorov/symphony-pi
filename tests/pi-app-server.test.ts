import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleLogger } from "../src/logger.js";
import { PiAppServerClient } from "../src/pi-app-server.js";
import type { CodexRuntimeEvent, Issue, SymphonyConfig } from "../src/types.js";

const fakeRpcSource = String.raw`
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const scenario = process.argv[2] || 'success';
const logPath = process.env.FAKE_PI_LOG;
const decoder = new StringDecoder('utf8');
let buffer = '';
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function log(message) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + '\n'); }
function handle(line) {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log(msg);
  if (msg.type === 'get_state') send({ id: msg.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'fake-rpc-session', thinkingLevel: 'medium', isStreaming: false, isCompacting: false, steeringMode: 'all', followUpMode: 'one-at-a-time', autoCompactionEnabled: false, messageCount: 0, pendingMessageCount: 0 } });
  else if (msg.type === 'get_messages') send({ id: msg.id, type: 'response', command: 'get_messages', success: true, data: { messages: [] } });
  else if (msg.type === 'set_session_name') send({ id: msg.id, type: 'response', command: 'set_session_name', success: true });
  else if (msg.type === 'set_model') send({ id: msg.id, type: 'response', command: 'set_model', success: true, data: { provider: msg.provider, id: msg.modelId } });
  else if (msg.type === 'set_thinking_level') send({ id: msg.id, type: 'response', command: 'set_thinking_level', success: true });
  else if (msg.type === 'extension_ui_response') send({ id: msg.id, type: 'response', command: 'extension_ui_response', success: true });
  else if (msg.type === 'abort') send({ id: msg.id, type: 'response', command: 'abort', success: true });
  else if (msg.type === 'get_last_assistant_text') send({ id: msg.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'Pi RPC worker completed.' } });
  else if (msg.type === 'prompt') {
    if (scenario === 'prompt-timeout') return;
    if (scenario === 'exit-during-prompt') process.exit(9);
    if (scenario === 'agent-timeout') {
      send({ id: msg.id, type: 'response', command: 'prompt', success: true });
      send({ type: 'agent_start', message: 'started but never finished' });
      return;
    }
    setTimeout(() => {
      send({ id: msg.id, type: 'response', command: 'prompt', success: true });
      send({ type: 'agent_start', message: scenario === 'unicode-lines' ? 'line and separator' : 'started' });
      if (scenario === 'user-input') send({ type: 'extension_ui_request', id: 'req-1', method: 'input', title: 'Need input' });
      if (scenario === 'notify') send({ type: 'extension_ui_request', id: 'req-2', method: 'notify', message: 'FYI' });
      send({ type: 'message_end', message: { usage: { input: 11, output: 7, total: 18 } } });
      send({ type: 'agent_end', messages: [], willRetry: false });
    }, 5);
  }
  else send({ id: msg.id, type: 'response', command: msg.type || 'unknown', success: false, error: 'unsupported fake RPC command: ' + msg.type });
}
function consume(text) {
  buffer += text;
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) break;
    let line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    handle(line);
  }
}
process.stdin.on('data', (chunk) => consume(decoder.write(chunk)));
process.stdin.on('end', () => {
  consume(decoder.end());
  if (buffer) handle(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
});
`;

test("Pi RPC client completes fake session and passes protocol config", async () => {
	const { workspace, command, logPath } = await setupFake("success");
	const events: CodexRuntimeEvent[] = [];
	const cfg = config(workspace, command);
	cfg.pi.modelProvider = "openai";
	cfg.pi.modelId = "gpt-test";
	cfg.pi.thinkingLevel = "high";
	const client = new PiAppServerClient(cfg, createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	assert.equal(events.some((event) => event.event === "pi_rpc_process_started" && event.session_id === "fake-rpc-session"), true);
	assert.equal(events.some((event) => event.event === "session_started" && event.session_id === "fake-rpc-session"), true);
	assert.equal(events.some((event) => event.event === "pi_agent_start"), true);
	assert.equal(events.some((event) => event.event === "pi_agent_end"), true);
	assert.equal(events.some((event) => event.event === "turn_completed"), true);
	assert.equal(events.some((event) => event.event === "item_completed" && event.message === "Pi RPC worker completed."), true);
	assert.equal(events.some((event) => event.usage), true);
	const messages = await readProtocolLog(logPath);
	assert.equal(messages[0].type, "get_state");
	assert.deepEqual(pick(messages.find((message) => message.type === "set_session_name")!, ["type", "name"]), { type: "set_session_name", name: "ABC-1: Test issue" });
	assert.deepEqual(pick(messages.find((message) => message.type === "set_model")!, ["type", "provider", "modelId"]), { type: "set_model", provider: "openai", modelId: "gpt-test" });
	assert.deepEqual(pick(messages.find((message) => message.type === "set_thinking_level")!, ["type", "level"]), { type: "set_thinking_level", level: "high" });
	assert.equal(messages.find((message) => message.type === "prompt")?.message, "Do work");
	assert.equal(messages.some((message) => message.type === "get_last_assistant_text"), true);
});

test("Pi RPC client uses strict LF-only JSONL framing", async () => {
	const { workspace, command } = await setupFake("unicode-lines");
	const events: CodexRuntimeEvent[] = [];
	const client = new PiAppServerClient(config(workspace, command), createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	assert.equal(events.some((event) => event.event === "pi_agent_start" && event.message === "line and separator"), true);
});

test("Pi RPC client cancels interactive extension UI and ignores notifications", async () => {
	const { workspace, command, logPath } = await setupFake("user-input");
	const events: CodexRuntimeEvent[] = [];
	const client = new PiAppServerClient(config(workspace, command), createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	const messages = await readProtocolLog(logPath);
	assert.deepEqual(pick(messages.find((message) => message.type === "extension_ui_response")!, ["type", "id", "cancelled"]), { type: "extension_ui_response", id: "req-1", cancelled: true });
	assert.equal(events.some((event) => event.event === "pi_extension_ui_request" && /cancelled/.test(event.message ?? "")), true);
	assert.equal(events.some((event) => event.event === "turn_completed"), true);

	const notifySetup = await setupFake("notify");
	const notifyEvents: CodexRuntimeEvent[] = [];
	const notifyClient = new PiAppServerClient(config(notifySetup.workspace, notifySetup.command), createConsoleLogger("test"));
	await notifyClient.runWorker({ workspacePath: notifySetup.workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => notifyEvents.push(event) });
	const notifyMessages = await readProtocolLog(notifySetup.logPath);
	assert.deepEqual(pick(notifyMessages.find((message) => message.type === "extension_ui_response")!, ["type", "id", "cancelled"]), { type: "extension_ui_response", id: "req-2", cancelled: true });
	assert.equal(notifyEvents.some((event) => event.event === "pi_extension_ui_request" && event.message === "Pi extension UI notify"), true);
});

test("Pi RPC client maps process exit, prompt timeout, and agent timeout", async () => {
	await assertScenarioRejects("exit-during-prompt", /process_exit/);
	await assertScenarioRejects("prompt-timeout", /response_timeout: prompt/);
	await assertScenarioRejects("agent-timeout", /response_timeout: agent_end/);
});

async function assertScenarioRejects(scenario: string, pattern: RegExp): Promise<void> {
	const { workspace, command } = await setupFake(scenario);
	const client = new PiAppServerClient(config(workspace, command, { readTimeoutMs: 500, turnTimeoutMs: 750 }), createConsoleLogger("test"));
	await assert.rejects(
		() => client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: () => {} }),
		pattern,
	);
}

async function setupFake(scenario: string): Promise<{ workspace: string; command: string; logPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-symphony-pi-rpc-root-"));
	const workspace = join(root, "ABC-1");
	await mkdir(workspace, { recursive: true });
	const fake = join(root, "fake-pi-rpc.cjs");
	const logPath = join(root, "protocol.jsonl");
	await writeFile(fake, fakeRpcSource);
	await chmod(fake, 0o755);
	return { workspace, logPath, command: `FAKE_PI_LOG=${shellQuote(logPath)} node ${shellQuote(fake)} ${shellQuote(scenario)}` };
}

async function readProtocolLog(path: string): Promise<any[]> {
	return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
		runner: { kind: "pi" },
		codex: { command: "codex app-server", readTimeoutMs: 1_000, turnTimeoutMs: 1_000, stallTimeoutMs: 300_000 },
		pi: { command, modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: overrides.readTimeoutMs ?? 1_000, turnTimeoutMs: overrides.turnTimeoutMs ?? 1_000, stallTimeoutMs: 300_000 },
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

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
