import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleLogger } from "../src/logger.js";
import { PiAppServerClient } from "../src/pi-app-server.js";
import type { CodexRuntimeEvent, Issue, SymphonyConfig } from "../src/types.js";

const fakeServerSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const scenario = process.argv[2] || 'success';
const logPath = process.env.FAKE_PI_LOG;
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function log(message) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + '\n'); }
send({ type: 'server_ready', data: { serverVersion: 'fake', protocolVersion: '2.0.0', transports: ['stdio'] } });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.type === 'create_session') send({ id: msg.id, type: 'response', command: 'create_session', success: true, data: { sessionId: msg.sessionId, sessionInfo: { sessionId: msg.sessionId, thinkingLevel: 'medium', isStreaming: false, messageCount: 0, createdAt: new Date().toISOString() } } });
  else if (msg.type === 'switch_session') send({ id: msg.id, type: 'response', command: 'switch_session', success: true, data: { sessionInfo: { sessionId: msg.sessionId, thinkingLevel: 'medium', isStreaming: false, messageCount: 0, createdAt: new Date().toISOString() } } });
  else if (msg.type === 'set_session_name') send({ id: msg.id, type: 'response', command: 'set_session_name', success: true });
  else if (msg.type === 'set_model') send({ id: msg.id, type: 'response', command: 'set_model', success: true, data: { model: { provider: msg.provider, id: msg.modelId } } });
  else if (msg.type === 'set_thinking_level') send({ id: msg.id, type: 'response', command: 'set_thinking_level', success: true });
  else if (msg.type === 'extension_ui_response') send({ id: msg.id, type: 'response', command: 'extension_ui_response', success: true });
  else if (msg.type === 'abort') send({ id: msg.id, type: 'response', command: 'abort', success: true });
  else if (msg.type === 'get_last_assistant_text') send({ id: msg.id, type: 'response', command: 'get_last_assistant_text', success: true, data: { text: 'Pi worker completed.' } });
  else if (msg.type === 'prompt') {
    if (scenario === 'prompt-timeout') return;
    if (scenario === 'exit-during-prompt') process.exit(9);
    if (scenario === 'user-input') {
      setTimeout(() => send({ type: 'event', sessionId: msg.sessionId, event: { type: 'extension_ui_request', requestId: 'req-1', method: 'input', title: 'Need input' } }), 5);
      return;
    }
    setTimeout(() => {
      send({ type: 'event', sessionId: msg.sessionId, event: { type: 'agent_start', message: 'started' } });
      send({ type: 'event', sessionId: msg.sessionId, event: { type: 'message_end', message: { usage: { input: 11, output: 7, total: 18 } } } });
      send({ id: msg.id, type: 'response', command: 'prompt', success: true });
    }, 5);
  }
});
`;

test("Pi app-server client completes fake Pi session and passes protocol config", async () => {
	const { workspace, command, logPath } = await setupFake("success");
	const events: CodexRuntimeEvent[] = [];
	const cfg = config(workspace, command);
	cfg.pi.modelProvider = "openai";
	cfg.pi.modelId = "gpt-test";
	cfg.pi.thinkingLevel = "high";
	const client = new PiAppServerClient(cfg, createConsoleLogger("test"));

	await client.runWorker({ workspacePath: workspace, issue: issue(), prompt: "Do work", continuationPrompts: [], onEvent: (event) => events.push(event) });

	assert.equal(events.some((event) => event.event === "pi_server_process_started"), true);
	assert.equal(events.some((event) => event.event === "session_started" && event.session_id?.startsWith("symphony-ABC-1-")), true);
	assert.equal(events.some((event) => event.event === "pi_agent_start"), true);
	assert.equal(events.some((event) => event.event === "turn_completed"), true);
	assert.equal(events.some((event) => event.event === "item_completed" && event.message === "Pi worker completed."), true);
	assert.equal(events.some((event) => event.usage), true);
	const messages = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(messages.find((message) => message.type === "create_session").cwd, workspace);
	assert.deepEqual(messages.find((message) => message.type === "set_session_name"), { id: "cmd-3", type: "set_session_name", sessionId: messages[0].sessionId, name: "ABC-1: Test issue" });
	assert.deepEqual(pick(messages.find((message) => message.type === "set_model"), ["type", "provider", "modelId"]), { type: "set_model", provider: "openai", modelId: "gpt-test" });
	assert.deepEqual(pick(messages.find((message) => message.type === "set_thinking_level"), ["type", "level"]), { type: "set_thinking_level", level: "high" });
	assert.equal(messages.find((message) => message.type === "prompt").message, "Do work");
	assert.equal(messages.some((message) => message.type === "get_last_assistant_text"), true);
});

test("Pi app-server client maps process exit, prompt timeout, and user input", async () => {
	await assertScenarioRejects("exit-during-prompt", /port_exit/);
	await assertScenarioRejects("prompt-timeout", /response_timeout: prompt/);
	const started = Date.now();
	await assertScenarioRejects("user-input", /turn_input_required/);
	assert.equal(Date.now() - started < 900, true);
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
	const root = await mkdtemp(join(tmpdir(), "pi-symphony-pi-root-"));
	const workspace = join(root, "ABC-1");
	await import("node:fs/promises").then((fs) => fs.mkdir(workspace, { recursive: true }));
	const fake = join(root, "fake-pi-server.cjs");
	const logPath = join(root, "protocol.jsonl");
	await writeFile(fake, fakeServerSource);
	await chmod(fake, 0o755);
	return { workspace, logPath, command: `FAKE_PI_LOG=${shellQuote(logPath)} node ${shellQuote(fake)} ${shellQuote(scenario)}` };
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
