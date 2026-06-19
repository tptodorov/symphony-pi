import test from "node:test";
import assert from "node:assert/strict";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SymphonyHttpServer } from "../src/http.js";

test("HTTP server exposes state, issue lookup, refresh, and dashboard", async () => {
	let refreshed = false;
	const dir = await mkdtemp(join(tmpdir(), "pi-symphony-http-"));
	const runDir = join(dir, ".symphony", "runs", "2026-01-01_ABC-1_attempt-1");
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "events.jsonl"), "INFO boot\nERROR OPENAI_API_KEY=sk-123456789012345 failed loudly\n", "utf8");
	await writeFile(join(runDir, "result.json"), JSON.stringify({ issue_identifier: "ABC-1", status: "failed", terminal_reason: "failed", workspace_path: "/tmp/work/ABC-1", last_error: "hook failed" }), "utf8");
	await writeFile(join(runDir, "prompt.md"), "prompt", "utf8");
	await writeFile(join(runDir, "metadata.json"), "{}", "utf8");
	const runtimeSnapshot = {
		generated_at: "2026-01-01T00:01:00.000Z",
		counts: { running: 1, retrying: 1 },
		running: [{ issue_identifier: "ABC-1", state: "In Progress", started_at: "2026-01-01T00:00:00.000Z", last_event: "turn_completed", artifact_path: runDir, logs: { codex_session_logs: [{ label: "Codex events", path: join(runDir, "events.jsonl"), url: `file://${join(runDir, "events.jsonl")}` }] }, tokens: { total_tokens: 1234 } }],
		retrying: [{ issue_identifier: "ABC-2", due_at: "2026-01-01T00:02:00.000Z", error: "retry soon", artifact_path: "/tmp/.symphony/runs/ABC-2" }],
		codex_totals: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234, seconds_running: 65 },
		rate_limits: { requests_remaining: 42 },
		workflow_path: join(dir, "WORKFLOW.md"),
		workflow_dir: dir,
		tracker_kind: "beads",
		max_concurrent_agents: 3,
		last_reload_at: "2026-01-01T00:00:00.000Z",
		http: { enabled: true, port: 9999 },
	};
	const issueSnapshot = {
		issue_identifier: "ABC-1",
		status: "running",
		last_error: "hook failed",
		workspace: { path: "/tmp/work/ABC-1" },
		recent_events: [{ at: "2026-01-01T00:00:00.000Z", event: "turn_completed", message: "done" }],
		recent_agent_messages: [
			{ at: "2026-01-01T00:00:30.000Z", text: "Investigating ABC-1\nFound <danger> & context\nAGENT_API_KEY=sk-abcdefghijkl", streaming: false },
			{ at: "2026-01-01T00:00:45.000Z", text: "Drafting the fix now", streaming: true },
		],
		artifacts: { events: join(runDir, "events.jsonl"), result: join(runDir, "result.json") },
		logs: { codex_session_logs: [{ label: "Codex events", path: join(runDir, "events.jsonl"), url: `file://${join(runDir, "events.jsonl")}` }] },
	};
	const retryIssueSnapshot = {
		issue_identifier: "ABC-2",
		status: "retrying",
		last_error: "turn_timeout: timed out",
		retry: { attempt: 2, due_at: "2026-01-01T00:02:00.000Z", error: "turn_timeout: timed out" },
		recent_events: [],
		artifacts: null,
	};
	const fallbackIssueSnapshot = {
		issue_identifier: "ABC-3",
		status: "running",
		last_error: null,
		workspace: { path: "/tmp/work/ABC-3" },
		recent_events: [
			{ at: "2026-01-01T00:01:00.000Z", event: "item_agentMessage_delta", payload: { delta: "Fallback <message> " } },
			{ at: "2026-01-01T00:01:01.000Z", event: "item_agentMessage_delta", message: "from recent events" },
			{ at: "2026-01-01T00:01:02.000Z", event: "turn_completed", message: "done" },
			{ timestamp: "2026-01-01T00:01:03.000Z", event: "item_agentMessage_delta", payload: { delta: "Streaming PASSWORD=letmein" } },
		],
		artifacts: null,
	};
	const queueSnapshot = {
		eligible: [{ issue: { identifier: "ABC-Q", title: "Ready queue item" }, eligibility: { eligible: true, reasons: [{ code: "ready", message: "Ready to dispatch" }] } }],
		notDispatchable: [{ issue: { identifier: "ABC-B", title: "Blocked queue item" }, eligibility: { eligible: false, reasons: [{ code: "blocked", message: "Blocked by ABC-0" }] } }],
		retrying: [{ issue_identifier: "ABC-R", due_at: "soon", error: "backoff" }],
	};
	const server = new SymphonyHttpServer({
		port: 0,
		snapshot: () => runtimeSnapshot,
		issueSnapshot: (identifier) => (identifier === "ABC-1" ? issueSnapshot : identifier === "ABC-2" ? retryIssueSnapshot : identifier === "ABC-3" ? fallbackIssueSnapshot : null),
		queueSnapshot: async () => queueSnapshot,
		refresh: async () => {
			refreshed = true;
		},
	});
	const { port } = await server.start();
	try {
		const state = await fetchJson(`http://127.0.0.1:${port}/api/v1/state`);
		assert.deepEqual(state, runtimeSnapshot);

		const issue = await fetchJson(`http://127.0.0.1:${port}/api/v1/ABC-1`);
		assert.deepEqual(issue, issueSnapshot);

		const queue = await fetchJson(`http://127.0.0.1:${port}/api/v1/queue`);
		assert.deepEqual(queue, queueSnapshot);

		const missing = await fetch(`http://127.0.0.1:${port}/api/v1/MISSING`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: { code: "issue_not_found", message: "Issue not found in current runtime state: MISSING" } });

		const wrongMethod = await fetch(`http://127.0.0.1:${port}/api/v1/state`, { method: "POST" });
		assert.equal(wrongMethod.status, 405);
		assert.equal(wrongMethod.headers.get("allow"), "GET");

		const refresh = await fetch(`http://127.0.0.1:${port}/api/v1/refresh`, { method: "POST" });
		assert.equal(refresh.status, 202);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(refreshed, true);

		const dashboard = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(dashboard.headers.get("content-type")?.startsWith("text/html"), true);
		const html = await dashboard.text();
		assert.match(html, /Operator command deck/);
		assert.match(html, /Runtime metrics/);
		assert.match(html, /Workload rail/);
		assert.match(html, /Control signals/);
		assert.match(html, /Queue signal/);
		assert.match(html, /Queue snapshot/);
		assert.match(html, /Ready queue item/);
		assert.match(html, /Blocked by ABC-0/);
		assert.match(html, /Run artifact browser/);
		assert.match(html, /prompt.md/);
		assert.match(html, /result.json/);
		assert.match(html, /Embedded log tail/);
		assert.match(html, /OPENAI_API_KEY=\[redacted\]/);
		assert.doesNotMatch(html, /sk-123456789012345/);
		assert.match(html, /Failure triage/);
		assert.match(html, /System facts/);
		assert.match(html, /Machine JSON APIs are still available for integrations/);
		assert.doesNotMatch(html, /Raw JSON snapshot/);
		assert.doesNotMatch(html, /JSON state API/);
		assert.doesNotMatch(html, /Issue JSON/);
		assert.match(html, /data-refresh-status/);
		assert.match(html, /Auto-refresh: every 3s/);
		assert.match(html, /DASHBOARD_REFRESH_INTERVAL_MS = 3000/);
		assert.match(html, /fetch\(stateUrl, \{ cache: &quot;no-store&quot; \}\)|fetch\(stateUrl, \{ cache: "no-store" \}\)/);
		assert.match(html, /window\.piSymphonyDashboard/);
		assert.match(html, /updateDashboard/);
		assert.match(html, /stale ·/);
		assert.match(html, /data-live="metrics"/);
		assert.match(html, /data-live="workload"/);
		assert.match(html, /data-live="control-signals"/);
		assert.doesNotMatch(html, /data-live="raw-snapshot"/);
		assert.match(html, /initial-dashboard-state/);
		assert.match(html, /data-refresh-now/);
		assert.match(html, /POST/);
		assert.match(html, /data-export-summary/);
		assert.match(html, /pi-symphony-dashboard-summary\.json/);
		assert.match(html, /data-theme-toggle/);
		assert.match(html, /localStorage/);
		assert.match(html, /prefers-reduced-motion/);
		assert.match(html, /Skip to dashboard content/);
		assert.match(html, /\/issue\/ABC-1/);
		assert.match(html, /ABC-1/);
		assert.match(html, /ABC-2/);
		assert.match(html, /turn_completed/);
		assert.match(html, /retry soon/);
		assert.match(html, /requests_remaining/);
		assert.match(html, /\/api\/v1\/state/);

		const issuePage = await fetch(`http://127.0.0.1:${port}/issue/ABC-1`);
		assert.equal(issuePage.status, 200);
		const issueHtml = await issuePage.text();
		assert.match(issueHtml, /Issue telemetry/);
		assert.match(issueHtml, /hook failed/);
		assert.match(issueHtml, /Agent messages/);
		assert.match(issueHtml, /Investigating ABC-1/);
		assert.match(issueHtml, /Found &lt;danger&gt; &amp; context/);
		assert.match(issueHtml, /AGENT_API_KEY=\[redacted\]/);
		assert.doesNotMatch(issueHtml, /sk-abcdefghijkl/);
		assert.match(issueHtml, /Drafting the fix now/);
		assert.match(issueHtml, /streaming/);
		assert.match(issueHtml, /Recent events/);
		assert.match(issueHtml, /\/tmp\/work\/ABC-1/);

		const retryPage = await fetch(`http://127.0.0.1:${port}/issue/ABC-2`);
		assert.equal(retryPage.status, 200);
		assert.match(await retryPage.text(), /codex timeout|turn_timeout|retrying/);

		const fallbackPage = await fetch(`http://127.0.0.1:${port}/issue/ABC-3`);
		assert.equal(fallbackPage.status, 200);
		const fallbackHtml = await fallbackPage.text();
		assert.match(fallbackHtml, /Fallback &lt;message&gt; from recent events/);
		assert.match(fallbackHtml, /Streaming PASSWORD=\[redacted\]/);
		assert.doesNotMatch(fallbackHtml, /PASSWORD=letmein/);

		const missingPage = await fetch(`http://127.0.0.1:${port}/issue/MISSING`);
		assert.equal(missingPage.status, 404);
		assert.match(await missingPage.text(), /Issue MISSING is not present/);
	} finally {
		await server.stop();
	}
});

async function fetchJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	assert.equal(response.status, 200);
	return response.json();
}
