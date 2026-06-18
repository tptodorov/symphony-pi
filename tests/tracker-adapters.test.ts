import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleLogger } from "../src/logger.js";
import { BeadsTrackerClient, createTrackerAdapter, JiraTrackerClient, LinearTrackerClient } from "../src/tracker.js";
import type { SymphonyConfig, TrackerKind } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;

test.afterEach(() => {
	globalThis.fetch = originalFetch;
	process.env.PATH = originalPath;
});

test("Linear adapter fetches active candidates with slugId filter and paginates in order", async () => {
	const requests: Array<{ query: string; variables: Record<string, unknown>; authorization: string | null }> = [];
	mockFetch(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push({ query: body.query, variables: body.variables, authorization: new Headers(init?.headers).get("authorization") });
		return jsonResponse({
			data: {
				issues: {
					nodes: [linearNode(body.variables.after ? "LIN-2" : "LIN-1")],
					pageInfo: body.variables.after ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: "cursor-1" },
				},
			},
		});
	});

	const client = new LinearTrackerClient(() => config("linear"), createConsoleLogger("test"));
	const issues = await client.fetchCandidateIssues();

	assert.deepEqual(issues.map((issue) => issue.identifier), ["LIN-1", "LIN-2"]);
	assert.equal(requests.length, 2);
	assert.match(requests[0]!.query, /slugId:\s*\{ eq: \$projectSlug \}/);
	assert.deepEqual(requests[0]!.variables, { projectSlug: "ABC", states: ["Todo", "In Progress"], first: 50, after: null });
	assert.equal(requests[1]!.variables.after, "cursor-1");
	assert.equal(requests[0]!.authorization, "linear-token");
});

test("Linear adapter state refresh uses GraphQL ID variable and maps GraphQL errors", async () => {
	const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
	mockFetch(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push({ query: body.query, variables: body.variables });
		return jsonResponse({ data: { issues: { nodes: [linearNode("LIN-1")] } } });
	});
	const client = new LinearTrackerClient(() => config("linear"), createConsoleLogger("test"));

	await client.fetchIssueStatesByIds(["uuid-1"]);

	assert.match(requests[0]!.query, /\$ids:\s*\[ID!\]/);
	assert.deepEqual(requests[0]!.variables, { ids: ["uuid-1"] });

	mockFetch(async () => jsonResponse({ errors: [{ message: "boom" }] }));
	await assert.rejects(() => client.fetchCandidateIssues(), /linear_graphql_errors/);
});

test("Linear GraphQL tool helper maps success, GraphQL errors, invalid args, and missing auth", async () => {
	const requests: any[] = [];
	mockFetch(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		return jsonResponse(body.query.includes("withErrors") ? { errors: [{ message: "bad" }], data: null } : { data: { viewer: { id: "me" } } });
	});
	const client = new LinearTrackerClient(() => config("linear"), createConsoleLogger("test"));

	assert.deepEqual(await client.linearGraphql("", {}), { success: false, error: "query must be non-empty" });
	assert.deepEqual(await client.linearGraphql("query A { viewer { id } } query B { viewer { id } }", {}), { success: false, error: "query must contain exactly one GraphQL operation" });
	assert.deepEqual(await client.linearGraphql("query { viewer { id } }", [] as any), { success: false, error: "variables must be an object" });
	const ok = await client.linearGraphql("query { viewer { id } }", { first: true });
	assert.equal(ok.success, true);
	assert.deepEqual(requests.at(-1), { query: "query { viewer { id } }", variables: { first: true } });
	const withErrors = await client.linearGraphql("query withErrors { viewer { id } }", {});
	assert.equal(withErrors.success, false);
	assert.deepEqual(withErrors.body, { errors: [{ message: "bad" }], data: null });

	const missingAuth = config("linear");
	missingAuth.tracker.apiKey = null;
	const noAuth = new LinearTrackerClient(() => missingAuth, createConsoleLogger("test"));
	assert.deepEqual(await noAuth.linearGraphql("query { viewer { id } }", {}), { success: false, error: "missing_tracker_api_key" });
});

test("Linear adapter maps non-200 and missing pagination cursor errors", async () => {
	const client = new LinearTrackerClient(() => config("linear"), createConsoleLogger("test"));
	mockFetch(async () => new Response("nope", { status: 500 }));
	await assert.rejects(() => client.fetchCandidateIssues(), /linear_api_status: 500/);

	mockFetch(async () =>
		jsonResponse({
			data: { issues: { nodes: [linearNode("LIN-1")], pageInfo: { hasNextPage: true, endCursor: null } } },
		}),
	);
	await assert.rejects(() => client.fetchCandidateIssues(), /linear_missing_end_cursor/);
});

test("Jira adapter builds default JQL, paginates, and uses Basic auth", async () => {
	const requests: Array<{ url: string; body: any; authorization: string | null }> = [];
	mockFetch(async (url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push({ url: String(url), body, authorization: new Headers(init?.headers).get("authorization") });
		return jsonResponse({
			issues: [jiraNode(body.nextPageToken ? "ABC-2" : "ABC-1")],
			nextPageToken: body.nextPageToken ? undefined : "next-page",
			isLast: Boolean(body.nextPageToken),
		});
	});

	const client = new JiraTrackerClient(() => config("jira"), createConsoleLogger("test"));
	const issues = await client.fetchCandidateIssues();

	assert.deepEqual(issues.map((issue) => issue.identifier), ["ABC-1", "ABC-2"]);
	assert.equal(requests[0]!.url, "https://example.atlassian.net/rest/api/3/search/jql");
	assert.equal(requests[0]!.body.jql, 'project = ABC AND status in ("To Do", "In Progress") ORDER BY priority ASC, created ASC');
	assert.equal(requests[1]!.body.nextPageToken, "next-page");
	assert.equal(requests[0]!.authorization, `Basic ${Buffer.from("dev@example.com:jira-token").toString("base64")}`);
});

test("Jira adapter honors custom JQL, refreshes keys, extracts blockers, and maps status errors", async () => {
	const requests: any[] = [];
	mockFetch(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		return jsonResponse({ issues: [jiraNode("ABC-1", true)], total: 1 });
	});
	const custom = config("jira");
	custom.tracker.jiraJql = "project = ABC AND labels = agent";
	const client = new JiraTrackerClient(() => custom, createConsoleLogger("test"));

	const [candidate] = await client.fetchCandidateIssues();
	await client.fetchIssueStatesByIds(["ABC-1", "ABC-2"]);

	assert.equal(requests[0].jql, "project = ABC AND labels = agent");
	assert.equal(requests[1].jql, 'key in ("ABC-1", "ABC-2")');
	assert.deepEqual(candidate?.blocked_by, [{ id: "ABC-0", identifier: "ABC-0", state: "Done" }]);

	mockFetch(async () => new Response("nope", { status: 401 }));
	await assert.rejects(() => client.fetchCandidateIssues(), /jira_api_status: 401/);
});

test("Beads adapter runs configured commands from workflow directory and filters state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-beads-"));
	const bin = await mkdtemp(join(tmpdir(), "pi-symphony-bin-"));
	await writeFile(
		join(bin, "fake-bd"),
		`#!/bin/sh
if [ "$1" = "ready" ]; then
  printf '[{"id":"bd-1","title":"Ready","status":"open","labels":["x"],"created_at":"%s"}]' "$PWD"
elif [ "$1" = "list" ]; then
  printf '[{"id":"bd-1","title":"Open","status":"open"},{"id":"bd-2","title":"Closed","status":"closed"}]'
elif [ "$1" = "show" ]; then
  printf '{"id":"%s","title":"Shown","status":"in_progress"}' "$2"
else
  echo bad >&2; exit 2
fi
`,
	);
	await chmod(join(bin, "fake-bd"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
	const beadsConfig = config("beads", cwd);
	const client = new BeadsTrackerClient(() => beadsConfig, createConsoleLogger("test"));

	const ready = await client.fetchCandidateIssues();
	const open = await client.fetchIssuesByStates(["open"]);
	const shown = await client.fetchIssueStatesByIds(["bd-3"]);

	assert.equal(ready[0]?.created_at, await realpath(cwd));
	assert.deepEqual(open.map((issue) => issue.identifier), ["bd-1"]);
	assert.deepEqual(shown.map((issue) => issue.identifier), ["bd-3"]);
});

test("Beads adapter maps malformed command output", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-beads-"));
	const bin = await mkdtemp(join(tmpdir(), "pi-symphony-bin-"));
	await writeFile(join(bin, "bad-bd"), "#!/bin/sh\necho not-json\n");
	await chmod(join(bin, "bad-bd"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
	const beadsConfig = config("beads", cwd);
	beadsConfig.tracker.beadsCommand = "bad-bd";
	beadsConfig.tracker.beadsReadyCommand = "bad-bd ready --json";
	const client = new BeadsTrackerClient(() => beadsConfig, createConsoleLogger("test"));

	await assert.rejects(() => client.fetchCandidateIssues(), /beads_command_failed/);
});

test("tracker factory creates adapters for all supported kinds", () => {
	assert.equal(createTrackerAdapter(() => config("linear"), createConsoleLogger("test")) instanceof LinearTrackerClient, true);
	assert.equal(createTrackerAdapter(() => config("jira"), createConsoleLogger("test")) instanceof JiraTrackerClient, true);
	assert.equal(createTrackerAdapter(() => config("beads"), createConsoleLogger("test")) instanceof BeadsTrackerClient, true);
});

function mockFetch(handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
	globalThis.fetch = handler as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function linearNode(identifier: string): any {
	return {
		id: `${identifier}-uuid`,
		identifier,
		title: `Issue ${identifier}`,
		description: "Description",
		priority: 2,
		branchName: `${identifier}-branch`,
		url: `https://linear.app/${identifier}`,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		state: { name: "Todo" },
		labels: { nodes: [{ name: "Bug" }] },
		inverseRelations: { nodes: [] },
	};
}

function jiraNode(key: string, blocked = false): any {
	return {
		key,
		self: `https://example.atlassian.net/rest/api/3/issue/${key}`,
		fields: {
			summary: `Issue ${key}`,
			description: { content: [{ content: [{ text: "ADF details" }] }] },
			priority: { name: "High" },
			status: { name: "To Do" },
			labels: ["Backend"],
			created: "2026-01-01T00:00:00.000+0000",
			updated: "2026-01-02T00:00:00.000+0000",
			issuelinks: blocked
				? [{ type: { name: "Blocks" }, inwardIssue: { key: "ABC-0", fields: { status: { name: "Done" } } } }]
				: [],
		},
	};
}

function config(kind: TrackerKind, workflowDir = process.cwd()): SymphonyConfig {
	return {
		workflowPath: join(workflowDir, "WORKFLOW.md"),
		workflowDir,
		tracker: {
			kind,
			endpoint: kind === "jira" ? "https://example.atlassian.net" : "https://linear.example/graphql",
			apiKey: kind === "linear" ? "linear-token" : null,
			projectSlug: "ABC",
			jiraEmail: "dev@example.com",
			jiraApiToken: "jira-token",
			jiraProjectKey: "ABC",
			jiraJql: null,
			beadsCommand: "fake-bd",
			beadsReadyCommand: "fake-bd ready --json",
			activeStates: kind === "jira" ? ["To Do", "In Progress"] : kind === "beads" ? ["open", "in_progress"] : ["Todo", "In Progress"],
			terminalStates: kind === "beads" ? ["closed"] : ["Done", "Canceled"],
		},
		polling: { intervalMs: 30_000 },
		workspace: { root: join(workflowDir, "workspaces") },
		hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 60_000 },
		agent: { maxConcurrentAgents: 10, maxTurns: 20, maxRetryBackoffMs: 300_000, maxConcurrentAgentsByState: {} },
		runner: { kind: "codex" },
		codex: { command: "codex app-server", turnTimeoutMs: 3_600_000, readTimeoutMs: 5_000, stallTimeoutMs: 300_000 },
		pi: { command: "pi --mode rpc", modelProvider: null, modelId: null, thinkingLevel: null, readTimeoutMs: 5_000, turnTimeoutMs: 3_600_000, stallTimeoutMs: 300_000 },
		server: {},
	};
}
