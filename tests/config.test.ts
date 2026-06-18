import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadResolvedConfig, loadWorkflow, probeConfig, validateDispatchConfig } from "../src/config.js";
import { renderPromptTemplate } from "../src/template.js";

const oldEnv = { ...process.env };
test.afterEach(() => {
	process.env = { ...oldEnv };
});

test("probeConfig reports missing default workflow", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));

	const probe = await probeConfig(cwd);

	assert.equal(probe.workflowExists, false);
	assert.equal(probe.error?.code, "missing_workflow_file");
});

test("loadWorkflow parses optional YAML front matter and prompt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	await writeFile(
		join(cwd, "WORKFLOW.md"),
		`---\ntracker:\n  kind: beads\n---\nHello {{ issue.identifier }} attempt={{ attempt }}`,
	);

	const workflow = await loadWorkflow(cwd);

	assert.equal(workflow.config.tracker && typeof workflow.config.tracker === "object", true);
	assert.equal(workflow.prompt_template, "Hello {{ issue.identifier }} attempt={{ attempt }}");
});

test("dispatch config requires explicit tracker kind and supports explicit Linear", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  api_key: $LINEAR_API_KEY\n  project_slug: ABC\n---\nTask`);

	await assert.rejects(() => loadResolvedConfig(cwd), (error: any) => error?.code === "missing_tracker_kind");

	process.env.LINEAR_API_KEY = "linear-token";
	await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: ABC\n---\nTask`);
	const { config } = await loadResolvedConfig(cwd);
	validateDispatchConfig(config);

	assert.equal(config.tracker.kind, "linear");
	assert.equal(config.tracker.apiKey, "linear-token");
	assert.equal(config.tracker.endpoint, "https://api.linear.app/graphql");
	assert.equal(config.tracker.projectSlug, "ABC");
});

test("resolved config loads workflow .env without mutating process env", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	await writeFile(join(cwd, ".env"), `LINEAR_API_KEY=linear-from-dotenv\nLINEAR_PROJECT_SLUG=PROJECT-FROM-DOTENV\n`);
	await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: $LINEAR_PROJECT_SLUG\n---\nTask`);

	const { config } = await loadResolvedConfig(cwd);
	validateDispatchConfig(config);

	assert.equal(config.tracker.apiKey, "linear-from-dotenv");
	assert.equal(config.tracker.projectSlug, "PROJECT-FROM-DOTENV");
	assert.equal(process.env.LINEAR_API_KEY, undefined);
});

test("resolved config supports Jira Cloud email/api token", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	process.env.JIRA_EMAIL = "dev@example.com";
	process.env.JIRA_API_TOKEN = "token";
	await writeFile(
		join(cwd, "WORKFLOW.md"),
		`---\ntracker:\n  kind: jira\n  endpoint: https://example.atlassian.net\n  email: $JIRA_EMAIL\n  api_token: $JIRA_API_TOKEN\n  project_key: ABC\nworkspace:\n  root: .symphony/workspaces\n---\nTask`,
	);

	const { config } = await loadResolvedConfig(cwd);
	validateDispatchConfig(config);

	assert.equal(config.tracker.kind, "jira");
	assert.equal(config.tracker.jiraEmail, "dev@example.com");
	assert.equal(config.tracker.jiraApiToken, "token");
	assert.equal(config.tracker.jiraProjectKey, "ABC");
	assert.match(config.workspace.root, /\.symphony\/workspaces$/);
});

test("resolved config rejects invalid numeric runtime values", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	const cases = [
		"polling:\n  interval_ms: 0",
		"codex:\n  turn_timeout_ms: -1",
		"codex:\n  read_timeout_ms: nope",
		"server:\n  port: 70000",
	];
	for (const body of cases) {
		await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  kind: beads\n${body}\n---\nTask`);
		await assert.rejects(() => loadResolvedConfig(cwd), (error: any) => error?.code === "invalid_config");
	}

	await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  kind: beads\ncodex:\n  stall_timeout_ms: 0\nserver:\n  port: 0\n---\nTask`);
	const { config } = await loadResolvedConfig(cwd);
	assert.equal(config.codex.stallTimeoutMs, 0);
	assert.equal(config.server.port, 0);
});

test("resolved config supports Beads extension when explicitly selected", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	await writeFile(join(cwd, "WORKFLOW.md"), `---\ntracker:\n  kind: beads\n  command: bd\n---\nTask`);

	const { config } = await loadResolvedConfig(cwd);
	validateDispatchConfig(config);

	assert.equal(config.tracker.kind, "beads");
	assert.equal(config.tracker.beadsReadyCommand, "bd ready --json");
	assert.deepEqual(config.tracker.activeStates, ["open", "in_progress"]);
	assert.equal(config.runner.kind, "codex");
});

test("resolved config supports Pi runner without adding package dependencies", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-"));
	await writeFile(
		join(cwd, "WORKFLOW.md"),
		`---\ntracker:\n  kind: beads\nrunner:\n  kind: pi\npi:\n  command: pi --mode rpc\n  model_provider: openai\n  model_id: gpt-test\n  thinking_level: high\n---\nTask`,
	);

	const { config } = await loadResolvedConfig(cwd);
	validateDispatchConfig(config);

	assert.equal(config.runner.kind, "pi");
	assert.equal(config.pi.command, "pi --mode rpc");
	assert.equal(config.pi.modelProvider, "openai");
	assert.equal(config.pi.modelId, "gpt-test");
	assert.equal(config.pi.thinkingLevel, "high");
	assert.equal(config.codex.command, "codex app-server");
});

test("prompt rendering is strict for unknown variables", async () => {
	await assert.rejects(
		() => renderPromptTemplate("{{ missing.value }}", minimalIssue(), null),
		/error|undefined|missing/i,
	);
});

function minimalIssue() {
	return {
		id: "ABC-1",
		identifier: "ABC-1",
		title: "Title",
		description: null,
		priority: null,
		state: "To Do",
		branch_name: null,
		url: null,
		labels: [],
		blocked_by: [],
		created_at: null,
		updated_at: null,
	};
}
