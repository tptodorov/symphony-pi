import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface SymphonyHttpServerOptions {
	port: number;
	host?: string;
	snapshot(): unknown;
	issueSnapshot(identifier: string): unknown | null;
	queueSnapshot?: () => Promise<unknown> | unknown;
	refresh(): Promise<void>;
}

export class SymphonyHttpServer {
	private server: Server | null = null;
	private boundPort: number | null = null;

	constructor(private readonly options: SymphonyHttpServerOptions) {}

	async start(): Promise<{ host: string; port: number }> {
		if (this.server) return { host: this.options.host ?? "127.0.0.1", port: this.boundPort ?? this.options.port };
		const host = this.options.host ?? "127.0.0.1";
		this.server = createServer((request, response) => void this.handle(request, response));
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				this.server?.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				this.server?.off("error", onError);
				const address = this.server?.address();
				this.boundPort = typeof address === "object" && address ? address.port : this.options.port;
				resolve();
			};
			this.server!.once("error", onError);
			this.server!.once("listening", onListening);
			this.server!.listen(this.options.port, host);
		});
		return { host, port: this.boundPort ?? this.options.port };
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		this.boundPort = null;
		if (!server) return;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const method = request.method ?? "GET";
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/") {
				if (method !== "GET") return methodNotAllowed(response, ["GET"]);
				const snapshot = this.options.snapshot();
				const queue = this.options.queueSnapshot ? await this.options.queueSnapshot() : null;
				return html(response, await renderDashboard(snapshot, queue));
			}
			const issuePageMatch = url.pathname.match(/^\/issue\/([^/]+)$/);
			if (issuePageMatch) {
				if (method !== "GET") return methodNotAllowed(response, ["GET"]);
				const identifier = decodeURIComponent(issuePageMatch[1]!);
				const issue = this.options.issueSnapshot(identifier);
				return html(response, renderIssuePage(identifier, issue), issue ? 200 : 404);
			}
			if (url.pathname === "/api/v1/state") {
				if (method !== "GET") return methodNotAllowed(response, ["GET"]);
				return json(response, 200, this.options.snapshot());
			}
			if (url.pathname === "/api/v1/queue") {
				if (method !== "GET") return methodNotAllowed(response, ["GET"]);
				if (!this.options.queueSnapshot) return jsonError(response, 501, "queue_unavailable", "Queue snapshot is not available for this runtime.");
				return json(response, 200, await this.options.queueSnapshot());
			}
			if (url.pathname === "/api/v1/refresh") {
				if (method !== "POST") return methodNotAllowed(response, ["POST"]);
				await drainRequest(request);
				void this.options.refresh();
				return json(response, 202, { queued: true, coalesced: false, requested_at: new Date().toISOString(), operations: ["poll", "reconcile"] });
			}
			const issueMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
			if (issueMatch) {
				if (method !== "GET") return methodNotAllowed(response, ["GET"]);
				const issue = this.options.issueSnapshot(decodeURIComponent(issueMatch[1]!));
				if (!issue) return jsonError(response, 404, "issue_not_found", `Issue not found in current runtime state: ${issueMatch[1]}`);
				return json(response, 200, issue);
			}
			return jsonError(response, 404, "not_found", `Route not found: ${url.pathname}`);
		} catch (error) {
			return jsonError(response, 500, "internal_error", error instanceof Error ? error.message : String(error));
		}
	}
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body, null, 2));
}

function html(response: ServerResponse, body: string, status = 200): void {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	response.end(body);
}

function jsonError(response: ServerResponse, status: number, code: string, message: string): void {
	json(response, status, { error: { code, message } });
}

function methodNotAllowed(response: ServerResponse, allow: string[]): void {
	response.writeHead(405, { allow: allow.join(", "), "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify({ error: { code: "method_not_allowed", message: `Method not allowed. Use ${allow.join(" or ")}.` } }));
}

async function drainRequest(request: IncomingMessage): Promise<void> {
	for await (const _chunk of request) {}
}

async function renderDashboard(snapshot: unknown, queue: unknown): Promise<string> {
	const root = objectValue(snapshot) ?? {};
	const counts = objectValue(root.counts) ?? {};
	const totals = objectValue(root.codex_totals) ?? {};
	const http = objectValue(root.http) ?? {};
	const running = arrayValue(root.running);
	const retrying = arrayValue(root.retrying);
	const artifacts = await recentRunArtifacts(root);
	const logs = await embeddedLogTail(root);
	const generatedAt = stringValue(root.generated_at) || new Date().toISOString();
	const workflowPath = stringValue(root.workflow_path) || "No workflow loaded";
	const trackerKind = stringValue(root.tracker_kind) || "tracker unknown";
	const maxAgents = numberValue(root.max_concurrent_agents);
	const runningCount = numberValue(counts.running) ?? running.length;
	const retryingCount = numberValue(counts.retrying) ?? retrying.length;
	const queueCount = queue ? queueTotal(queue) : numberValue(counts.queued) ?? numberValue(counts.queue) ?? null;
	const daemonState = stringValue(root.last_reload_error) ? "attention" : "online";
	const safeJson = escapeHtml(JSON.stringify(snapshot, null, 2));
	return `<!doctype html>${documentHead("pi-symphony dashboard")}
<body>
<a class="skip-link" href="#content">Skip to dashboard content</a>
<main id="content" role="main">
<section class="hero" aria-label="Symphony command deck">
	<div class="hero-grid">
		<div>
			<div class="kicker">Operator command deck</div>
			<h1>pi-symphony</h1>
			<p class="subtitle">Live orchestration telemetry for autonomous issue runs. Use the console for control; use this dashboard for scan-friendly status, artifacts, and shareable API links.</p>
		</div>
		<div class="status-pill ${daemonState}" data-dashboard-state><span class="dot"></span>${escapeHtml(daemonState)}</div>
	</div>
	<div class="meta-strip">
		<span class="chip">Workflow: ${escapeHtml(workflowPath)}</span>
		<span class="chip">Tracker: ${escapeHtml(trackerKind)}</span>
		<span class="chip">Generated: ${escapeHtml(generatedAt)}</span>
		<span class="chip">HTTP: ${stringValue(http.port) ? `:${escapeHtml(stringValue(http.port))}` : "enabled"}</span>
	</div>
	<div class="actions" aria-label="Dashboard actions">
		<button class="button" type="button" data-refresh-now>Refresh now</button>
		<button class="button" type="button" data-export-summary>Download safe summary</button>
		<button class="button" type="button" data-theme-toggle>Toggle theme</button>
	</div>
	<div class="live-strip" aria-live="polite">
		<span class="status-pill" data-refresh-status><span class="dot"></span>live · initial snapshot</span>
		<span class="chip">Auto-refresh: every 3s</span>
	</div>
</section>

<section class="grid metrics" aria-label="Runtime metrics" data-live="metrics">
	${renderMetricCard("Agents", `${runningCount}${maxAgents === null ? "" : ` / ${maxAgents}`}`, "active workers / configured capacity", "ok")}
	${renderMetricCard("Retry", String(retryingCount), "runs waiting for backoff or continuation", retryingCount > 0 ? "warn" : "ok")}
	${renderMetricCard("Queue", queueCount === null ? "—" : String(queueCount), queueCount === null ? "candidate queue is inspected in /symphony" : "candidate issues in snapshot", "")}
	${renderMetricCard("Tokens", formatInt(numberValue(totals.total_tokens) ?? 0), `${formatDuration(numberValue(totals.seconds_running) ?? 0)} agent runtime`, "")}
</section>

<section class="grid deck" aria-label="Workload and observability">
	<div class="panel" data-live="workload"><h2>Workload rail</h2>${renderWorkers(running, "running")}${renderWorkers(retrying, "retrying")}</div>
	<div class="panel" data-live="control-signals"><h2>Control signals</h2>${renderReloadState(root)}${renderRateLimits(root.rate_limits)}${renderQueueSignal(queueCount)}</div>
</section>

<section class="grid deck" aria-label="Queue and artifacts">
	<div class="panel"><h2>Queue snapshot</h2>${renderQueuePanel(queue)}</div>
	<div class="panel"><h2>Run artifact browser</h2>${renderArtifacts(artifacts)}</div>
</section>

<section class="panel" aria-label="Embedded log tail"><h2>Embedded log tail</h2>${renderLogs(logs)}</section>

${renderSystemSummary(root, queue, artifacts)}
<script type="application/json" id="initial-dashboard-state">${safeJson}</script>
</main>
${renderDashboardScript()}
</body>
</html>`;
}

function renderIssuePage(identifier: string, issue: unknown): string {
	const root = objectValue(issue);
	if (!root) {
		return `<!doctype html>${documentHead(`Issue ${identifier} not found`)}<body><main role="main"><section class="hero"><div class="kicker">Issue telemetry</div><h1>404</h1><p class="subtitle">Issue ${escapeHtml(identifier)} is not present in the current runtime state.</p><div class="actions"><a class="button" href="/">Back to dashboard</a></div></section></main></body></html>`;
	}
	const artifacts = objectValue(root.artifacts);
	const running = objectValue(root.running);
	const retry = objectValue(root.retry);
	const workspace = objectValue(root.workspace);
	const triage = classifyFailure(root);
	return `<!doctype html>${documentHead(`Issue ${identifier}`)}<body><main role="main">
<section class="hero"><div class="kicker">Issue telemetry</div><h1>${escapeHtml(stringValue(root.issue_identifier) || identifier)}</h1><p class="subtitle">Visual runtime telemetry for this issue: state, artifacts, retry context, recent events, and likely next action.</p><div class="actions"><a class="button" href="/">Dashboard</a></div></section>
<section class="grid metrics" aria-label="Issue metrics">
${renderMetricCard("Status", stringValue(root.status) || (running ? "running" : retry ? "retrying" : "unknown"), "current runtime rail", running ? "ok" : retry ? "warn" : "")}
${renderMetricCard("Terminal", stringValue(root.terminal_reason) || "—", "terminal reason if known", stringValue(root.terminal_reason) ? "warn" : "")}
${renderMetricCard("Attempts", formatLooseValue(objectValue(root.attempts) ?? {}), "retry and restart metadata", "")}
${renderMetricCard("Triage", triage.category, triage.action, triage.severity === "error" ? "bad" : triage.severity === "warning" ? "warn" : "ok")}
</section>
<section class="grid" aria-label="Agent messages"><div class="panel"><h2>Agent messages</h2>${renderAgentMessages(root)}</div></section>
<section class="grid deck"><div class="panel"><h2>Runtime detail</h2>${renderIssueRuntime(root, workspace, artifacts)}</div><div class="panel"><h2>Recent events</h2>${renderRecentEvents(arrayValue(root.recent_events))}</div></section>
${renderIssueSummary(root)}
</main></body></html>`;
}

function documentHead(title: string): string {
	return `<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>${DASHBOARD_CSS}</style></head>`;
}

const DASHBOARD_CSS = `
:root { color-scheme: dark; --bg:#080a0c; --panel:rgba(17,22,24,.82); --line:rgba(159,255,216,.18); --line-hot:rgba(255,196,87,.42); --text:#ecfdf5; --muted:#8ea9a0; --dim:#5f766f; --ok:#78f7bf; --warn:#ffd166; --bad:#ff6b6b; --cyan:#7dd3fc; font-family:"Avenir Next","Gill Sans","Segoe UI",sans-serif; }
[data-theme="paper"] { color-scheme: light; --bg:#f6f1e7; --panel:rgba(255,252,244,.9); --line:rgba(54,78,67,.22); --line-hot:rgba(176,116,24,.42); --text:#17211d; --muted:#52635c; --dim:#7d8b85; --ok:#087f5b; --warn:#a16207; --bad:#b42318; --cyan:#0369a1; }
*{box-sizing:border-box} body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(circle at 12% 10%,rgba(120,247,191,.18),transparent 28rem),radial-gradient(circle at 82% 18%,rgba(125,211,252,.12),transparent 26rem),linear-gradient(135deg,var(--bg) 0%,#0a1010 54%,#11100b 100%)}
[data-theme="paper"] body, body[data-theme="paper"]{background:linear-gradient(135deg,#f6f1e7,#e7efe8)} body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,black,transparent 86%)}
a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}.skip-link{position:absolute;left:-999px;top:8px;background:var(--panel);padding:10px;border-radius:10px}.skip-link:focus{left:8px;z-index:10}button,a{outline-color:var(--cyan);outline-offset:3px}main{width:min(1480px,calc(100vw - 32px));margin:0 auto;padding:28px 0 48px;position:relative}.hero{border:1px solid var(--line);border-radius:28px;padding:28px;background:linear-gradient(135deg,rgba(14,19,20,.92),rgba(23,29,27,.74));box-shadow:0 30px 90px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden;position:relative}.hero::after{content:"SYMPHONY";position:absolute;right:-18px;top:-18px;font-size:clamp(56px,10vw,148px);font-weight:900;letter-spacing:-.08em;color:rgba(120,247,191,.045);line-height:.8}.kicker{color:var(--ok);text-transform:uppercase;letter-spacing:.24em;font-size:12px;font-weight:800}h1{margin:10px 0;font-size:clamp(38px,7vw,92px);line-height:.86;letter-spacing:-.07em}.subtitle{color:var(--muted);max-width:860px;font-size:16px;line-height:1.6}.hero-grid{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;position:relative;z-index:1}.status-pill{display:inline-flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:9px 13px;background:rgba(0,0,0,.18);color:var(--ok);font-weight:800;text-transform:uppercase;letter-spacing:.11em;font-size:12px}.status-pill.attention,.status-pill.stale{color:var(--warn);border-color:var(--line-hot)}.status-pill.error{color:var(--bad);border-color:rgba(255,107,107,.55)}.live-strip,.meta-strip,.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;position:relative;z-index:1}.dot{width:10px;height:10px;border-radius:50%;background:currentColor;box-shadow:0 0 22px currentColor}.chip{border:1px solid rgba(255,255,255,.11);color:var(--muted);background:rgba(255,255,255,.035);padding:8px 10px;border-radius:12px;font-size:13px}.grid{display:grid;gap:16px;margin-top:16px}.metrics{grid-template-columns:repeat(4,minmax(0,1fr))}.deck{grid-template-columns:minmax(0,1.25fr) minmax(360px,.75fr);align-items:start}.card,.panel{border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:inset 0 1px 0 rgba(255,255,255,.055),0 20px 60px rgba(0,0,0,.22)}.card{padding:20px;min-height:132px;position:relative;overflow:hidden}.card .label{color:var(--muted);text-transform:uppercase;letter-spacing:.16em;font-size:11px;font-weight:800}.card .value{display:block;margin-top:14px;font-size:clamp(28px,5vw,52px);line-height:.95;font-weight:900;letter-spacing:-.06em;overflow-wrap:anywhere}.card .note{margin-top:12px;color:var(--dim);font-size:13px}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.panel{padding:20px}.panel h2{margin:0 0 14px;font-size:16px;text-transform:uppercase;letter-spacing:.17em;color:var(--muted)}.worker-list{display:grid;gap:12px}.worker{border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:14px;background:linear-gradient(135deg,rgba(255,255,255,.045),rgba(255,255,255,.015))}.worker-head{display:flex;align-items:baseline;justify-content:space-between;gap:14px}.worker strong{font-size:20px;letter-spacing:-.02em}.badge{display:inline-flex;border:1px solid currentColor;border-radius:999px;padding:4px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:900}.badge.running{color:var(--ok)}.badge.retrying{color:var(--warn)}.badge.failed{color:var(--bad)}.worker-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.kv{color:var(--dim);font-size:12px}.kv b{display:block;color:var(--text);font-size:13px;margin-top:3px;overflow-wrap:anywhere}.event{margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08);color:var(--muted);overflow-wrap:anywhere}.empty{color:var(--dim);border:1px dashed rgba(255,255,255,.15);border-radius:18px;padding:22px;background:rgba(0,0,0,.14)}.rate-grid{display:grid;gap:10px}.rate{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08);color:var(--muted)}.rate b{color:var(--text);overflow-wrap:anywhere;text-align:right}.button{border:1px solid var(--line);background:rgba(120,247,191,.08);color:var(--text);border-radius:14px;padding:10px 12px;font-weight:800;cursor:pointer}.path{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:var(--muted);overflow-wrap:anywhere}details{margin-top:16px}summary{cursor:pointer;color:var(--muted);font-weight:800}pre{overflow:auto;max-height:520px;background:#050707;border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:18px;line-height:1.45;color:#d8fff0}.agent-message-list{display:grid;gap:14px}.agent-message .worker-head{align-items:center}.message-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.message-text{white-space:pre-wrap;max-height:760px;margin:10px 0 0}@media(max-width:960px){main{width:min(100vw - 20px,1480px);padding-top:10px}.hero-grid,.deck,.metrics{grid-template-columns:1fr}.worker-grid{grid-template-columns:1fr}.hero{padding:20px;border-radius:20px}}@media(prefers-reduced-motion:reduce){*,::before,::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

function renderMetricCard(label: string, value: string, note: string, tone: string): string {
	return `<article class="card ${escapeHtml(tone)}"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span><div class="note">${escapeHtml(note)}</div></article>`;
}

function renderWorkers(rows: Record<string, unknown>[], status: "running" | "retrying"): string {
	if (rows.length === 0) return `<div class="empty">No ${status} workers right now.</div>`;
	return `<div class="worker-list">${rows.map((row) => renderWorker(row, status)).join("\n")}</div>`;
}

function renderWorker(row: Record<string, unknown>, status: "running" | "retrying"): string {
	const identifier = stringValue(row.issue_identifier) || stringValue(row.issue_id) || "unknown";
	const last = stringValue(row.last_event) || stringValue(row.error) || "—";
	const artifact = stringValue(row.artifact_path) || stringValue(objectValue(row.artifacts)?.dir) || "—";
	const state = stringValue(row.state) || stringValue(row.terminal_reason) || status;
	const tokens = objectValue(row.tokens);
	const dueAt = stringValue(row.due_at);
	const triage = classifyFailure(row);
	return `<article class="worker">
		<div class="worker-head"><strong>${escapeHtml(identifier)}</strong><span class="badge ${status}">${status}</span></div>
		<div class="worker-grid"><div class="kv">State<b>${escapeHtml(state)}</b></div><div class="kv">Age / due<b>${escapeHtml(dueAt || formatAge(stringValue(row.started_at)))}</b></div><div class="kv">Tokens<b>${escapeHtml(formatInt(numberValue(tokens?.total_tokens) ?? 0))}</b></div></div>
		<div class="event">Last signal: ${escapeHtml(last)}</div>
		<div class="event">Failure triage: <span class="badge ${triage.severity === "error" ? "failed" : triage.severity === "warning" ? "retrying" : "running"}">${escapeHtml(triage.category)}</span> ${escapeHtml(triage.action)}</div>
		<div class="path">Artifact: ${escapeHtml(artifact)}</div>
		${identifier !== "unknown" ? `<div class="actions"><a class="button" href="/issue/${encodeURIComponent(identifier)}">Issue telemetry</a></div>` : ""}
	</article>`;
}

function renderReloadState(root: Record<string, unknown>): string {
	const error = stringValue(root.last_reload_error);
	if (error) return `<div class="worker"><div class="worker-head"><strong>Reload attention</strong><span class="badge failed">error</span></div><div class="event">${escapeHtml(error)}</div></div>`;
	return `<div class="worker"><div class="worker-head"><strong>Reload healthy</strong><span class="badge running">ok</span></div><div class="event">Last reload: ${escapeHtml(stringValue(root.last_reload_at) || "not recorded")}</div></div>`;
}

function renderRateLimits(rateLimits: unknown): string {
	const limits = objectValue(rateLimits);
	if (!limits) return `<div class="empty">No Codex rate-limit telemetry reported yet.</div>`;
	const rows = Object.entries(limits).slice(0, 10).map(([key, value]) => `<div class="rate"><span>${escapeHtml(key)}</span><b>${escapeHtml(formatLooseValue(value))}</b></div>`).join("\n");
	return `<div class="rate-grid" aria-label="Rate limits">${rows}</div>`;
}

function renderQueueSignal(queueCount: number | null): string {
	return `<div class="worker"><div class="worker-head"><strong>Queue signal</strong><span class="badge ${queueCount === null ? "retrying" : "running"}">${queueCount === null ? "console" : "live"}</span></div><div class="event">${queueCount === null ? "Candidate queue is still controlled from the /symphony TUI Queue tab; HTTP snapshot currently exposes active and retry rails." : `${queueCount} candidate issue(s) in snapshot.`}</div></div>`;
}

function renderQueuePanel(queue: unknown): string {
	const root = objectValue(queue);
	if (!root) return `<div class="empty">Queue snapshot endpoint unavailable.</div>`;
	const ready = arrayValue(root.eligible);
	const blocked = arrayValue(root.notDispatchable);
	const changed = arrayValue(root.recentlyChanged);
	const retrying = arrayValue(root.retrying);
	const rows = [...ready.map((row) => queueRow(row, "ready")), ...blocked.map((row) => queueRow(row, "not-dispatchable")), ...changed.map((row) => queueRow(row, "changed")), ...retrying.map((row) => retryQueueRow(row))].join("\n");
	return `${renderMetricCard("Ready", String(ready.length), "dispatchable candidates", ready.length > 0 ? "ok" : "")}${renderMetricCard("Blocked", String(blocked.length), "not dispatchable now", blocked.length > 0 ? "warn" : "")}${renderMetricCard("Changed", String(changed.length), "recently left active queue", changed.length > 0 ? "warn" : "")}${rows || `<div class="empty">No queue rows in snapshot.</div>`}`;
}

function queueRow(row: Record<string, unknown>, status: string): string {
	const issue = objectValue(row.issue) ?? {};
	const eligibility = objectValue(row.eligibility) ?? {};
	const reasons = arrayValue(eligibility.reasons);
	const reason = objectValue(reasons[0]) ?? {};
	return `<div class="worker"><div class="worker-head"><strong>${escapeHtml(stringValue(issue.identifier) || "unknown")}</strong><span class="badge ${status === "ready" ? "running" : "retrying"}">${escapeHtml(status)}</span></div><div class="event">${escapeHtml(stringValue(issue.title) || stringValue(reason.message) || "—")}</div><div class="path">Reason: ${escapeHtml(stringValue(reason.code) || "ready")} ${escapeHtml(stringValue(reason.message))}</div></div>`;
}

function retryQueueRow(row: Record<string, unknown>): string {
	return `<div class="worker"><div class="worker-head"><strong>${escapeHtml(stringValue(row.issue_identifier) || "retry")}</strong><span class="badge retrying">retry</span></div><div class="event">${escapeHtml(stringValue(row.error) || "backoff")}</div><div class="path">Due: ${escapeHtml(stringValue(row.due_at) || "—")}</div></div>`;
}

function renderArtifacts(artifacts: RunArtifact[]): string {
	if (artifacts.length === 0) return `<div class="empty">No recent .symphony/runs artifacts found.</div>`;
	return `<div class="worker-list">${artifacts.map((artifact) => `<article class="worker"><div class="worker-head"><strong>${escapeHtml(artifact.issueIdentifier)}</strong><span class="badge ${artifact.status === "failed" ? "failed" : artifact.status === "succeeded" ? "running" : "retrying"}">${escapeHtml(artifact.status)}</span></div><div class="worker-grid"><div class="kv">Terminal<b>${escapeHtml(artifact.terminalReason || "—")}</b></div><div class="kv">Age<b>${escapeHtml(formatAgeMs(artifact.mtimeMs))}</b></div><div class="kv">Workspace<b>${escapeHtml(artifact.workspacePath || "—")}</b></div></div><div class="event">${escapeHtml(artifact.error || "No error summary")}</div><div class="path">${escapeHtml(artifact.path)}</div><div class="actions">${artifact.files.map((file) => `<span class="chip">${escapeHtml(file)}</span>`).join("")}</div></article>`).join("\n")}</div>`;
}

function renderLogs(logs: LogExcerpt[]): string {
	if (logs.length === 0) return `<div class="empty">No readable run log tail found in active/retry artifacts.</div>`;
	return `<div class="worker-list">${logs.map((log) => `<article class="worker"><div class="worker-head"><strong>${escapeHtml(log.label)}</strong><span class="badge ${log.latestError ? "failed" : "running"}">${log.latestError ? "error" : "tail"}</span></div><div class="path">${escapeHtml(log.path)}</div><pre>${escapeHtml(log.lines.join("\n"))}</pre></article>`).join("\n")}</div>`;
}

function renderIssueRuntime(root: Record<string, unknown>, workspace: Record<string, unknown> | null, artifacts: Record<string, unknown> | null): string {
	const lastError = stringValue(root.last_error);
	return `<div class="worker"><div class="worker-head"><strong>${escapeHtml(stringValue(root.issue_identifier) || "issue")}</strong><span class="badge ${stringValue(root.status) === "running" ? "running" : "retrying"}">${escapeHtml(stringValue(root.status) || "unknown")}</span></div><div class="event">Last error: ${escapeHtml(lastError || "none")}</div><div class="path">Workspace: ${escapeHtml(stringValue(workspace?.path) || "—")}</div><div class="path">Artifacts: ${escapeHtml(formatLooseValue(artifacts ?? {}))}</div></div>`;
}

function renderAgentMessages(root: Record<string, unknown>): string {
	const messages = agentMessagesFromIssue(root).slice(-4);
	if (messages.length === 0) return `<div class="empty">No agent text yet. Open logs for raw runtime events.</div>`;
	return `<div class="agent-message-list">${messages.map((message, index) => {
		const text = redactText(message.text.trimEnd()) || "-";
		return `<article class="worker agent-message"><div class="worker-head"><strong>Message ${index + 1}</strong><span class="badge ${message.streaming ? "retrying" : "running"}">${message.streaming ? "streaming" : "sent"}</span></div><div class="message-meta">${message.at ? `<span class="chip">${escapeHtml(message.at)}</span>` : ""}</div><pre class="message-text">${escapeHtml(text)}</pre></article>`;
	}).join("\n")}</div>`;
}

function agentMessagesFromIssue(root: Record<string, unknown>): AgentMessage[] {
	const direct = agentMessagesFromValue(root.recent_agent_messages);
	if (direct.length > 0) return direct;
	const running = objectValue(root.running);
	const runningMessages = running ? agentMessagesFromValue(running.recent_agent_messages) : [];
	if (runningMessages.length > 0) return runningMessages;
	const eventMessages = agentMessagesFromEvents(arrayValue(root.recent_events));
	if (eventMessages.length > 0) return eventMessages;
	return running ? agentMessagesFromEvents(arrayValue(running.recent_events)) : [];
}

function agentMessagesFromValue(value: unknown): AgentMessage[] {
	return arrayValue(value)
		.map((message) => ({ at: stringValue(message.at), text: stringValue(message.text), streaming: Boolean(message.streaming) }))
		.filter((message) => message.text.trim().length > 0);
}

function agentMessagesFromEvents(events: Record<string, unknown>[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let current = "";
	let at = "";
	for (const event of events) {
		const name = stringValue(event.event);
		if (name === "item_agentMessage_delta") {
			const payload = objectValue(event.payload);
			const delta = stringValue(payload?.delta) || stringValue(event.message);
			if (!delta) continue;
			if (!current) at = stringValue(event.at) || stringValue(event.timestamp);
			current += delta;
		} else if (current) {
			messages.push({ at, text: current, streaming: false });
			current = "";
			at = "";
		}
	}
	if (current) messages.push({ at, text: current, streaming: true });
	return messages;
}

function renderRecentEvents(events: Record<string, unknown>[]): string {
	if (events.length === 0) return `<div class="empty">No recent events reported.</div>`;
	return events.slice(-12).map((event) => `<div class="worker"><div class="worker-head"><strong>${escapeHtml(stringValue(event.event) || "event")}</strong><span class="badge running">event</span></div><div class="event">${escapeHtml(stringValue(event.message) || "—")}</div><div class="path">${escapeHtml(stringValue(event.at) || "—")}</div></div>`).join("\n");
}

function renderSystemSummary(root: Record<string, unknown>, queue: unknown, artifacts: RunArtifact[]): string {
	const queueRoot = objectValue(queue);
	return `<section class="panel" aria-label="System facts"><h2>System facts</h2><div class="worker-grid"><div class="kv">Workflow<b>${escapeHtml(stringValue(root.workflow_path) || "—")}</b></div><div class="kv">Workflow dir<b>${escapeHtml(stringValue(root.workflow_dir) || "—")}</b></div><div class="kv">Tracker<b>${escapeHtml(stringValue(root.tracker_kind) || "—")}</b></div><div class="kv">Poll interval<b>${escapeHtml(formatLooseValue(root.poll_interval_ms))} ms</b></div><div class="kv">Artifacts indexed<b>${artifacts.length}</b></div><div class="kv">Queue fetched<b>${queueRoot ? escapeHtml(stringValue(queueRoot.fetched_at) || "available") : "unavailable"}</b></div></div><p class="subtitle">Machine JSON APIs are still available for integrations, but the operator dashboard stays visual-first.</p></section>`;
}

function renderIssueSummary(root: Record<string, unknown>): string {
	const attempts = objectValue(root.attempts) ?? {};
	return `<section class="panel" aria-label="Issue facts"><h2>Issue facts</h2><div class="worker-grid"><div class="kv">Issue ID<b>${escapeHtml(stringValue(root.issue_id) || "—")}</b></div><div class="kv">Restart count<b>${escapeHtml(formatLooseValue(attempts.restart_count))}</b></div><div class="kv">Current retry<b>${escapeHtml(formatLooseValue(attempts.current_retry_attempt))}</b></div></div></section>`;
}

function renderDashboardScript(): string {
	return `<script>
(() => {
	const DASHBOARD_REFRESH_INTERVAL_MS = 3000;
	const stateUrl = "/api/v1/state";
	let latestSnapshot = null;
	const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
	const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const arr = (value) => Array.isArray(value) ? value.filter((row) => row && typeof row === "object" && !Array.isArray(row)) : [];
	const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
	const str = (value) => typeof value === "string" || typeof value === "number" ? String(value) : "";
	const int = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");
	const redact = (text) => String(text).replace(/\\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*)=([^\\s\"]+)/gi, "$1=[redacted]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
	const duration = (totalSeconds) => { const seconds = Math.max(Math.floor(Number(totalSeconds) || 0), 0); const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60; return h > 0 ? h + "h " + m + "m" : m > 0 ? m + "m " + s + "s" : s + "s"; };
	const age = (iso) => { const timestamp = Date.parse(str(iso)); return Number.isFinite(timestamp) ? duration((Date.now() - timestamp) / 1000) + " ago" : "—"; };
	const metric = (label, value, note, tone) => '<article class="card ' + esc(tone) + '" data-metric="' + esc(label.toLowerCase()) + '"><span class="label">' + esc(label) + '</span><span class="value">' + esc(value) + '</span><div class="note">' + esc(note) + '</div></article>';
	const worker = (row, status) => { const tokens = obj(row.tokens); const identifier = str(row.issue_identifier) || str(row.issue_id) || "unknown"; const state = str(row.state) || str(row.terminal_reason) || status; const last = str(row.last_event) || str(row.error) || "—"; const artifact = str(row.artifact_path) || str(obj(row.artifacts).dir) || "—"; const due = str(row.due_at); return '<article class="worker"><div class="worker-head"><strong>' + esc(identifier) + '</strong><span class="badge ' + status + '">' + status + '</span></div><div class="worker-grid"><div class="kv">State<b>' + esc(state) + '</b></div><div class="kv">Age / due<b>' + esc(due || age(row.started_at)) + '</b></div><div class="kv">Tokens<b>' + esc(int(num(tokens.total_tokens) ?? 0)) + '</b></div></div><div class="event">Last signal: ' + esc(last) + '</div><div class="path">Artifact: ' + esc(artifact) + '</div>' + (identifier === "unknown" ? "" : '<div class="actions"><a class="button" href="/issue/' + encodeURIComponent(identifier) + '">Issue telemetry</a></div>') + '</article>'; };
	const workers = (rows, status) => rows.length === 0 ? '<div class="empty">No ' + status + ' workers right now.</div>' : '<div class="worker-list">' + rows.map((row) => worker(row, status)).join("") + '</div>';
	const reloadState = (root) => str(root.last_reload_error) ? '<div class="worker"><div class="worker-head"><strong>Reload attention</strong><span class="badge failed">error</span></div><div class="event">' + esc(root.last_reload_error) + '</div></div>' : '<div class="worker"><div class="worker-head"><strong>Reload healthy</strong><span class="badge running">ok</span></div><div class="event">Last reload: ' + esc(str(root.last_reload_at) || "not recorded") + '</div></div>';
	const rates = (rateLimits) => { const entries = Object.entries(obj(rateLimits)).slice(0, 10); return entries.length === 0 ? '<div class="empty">No Codex rate-limit telemetry reported yet.</div>' : '<div class="rate-grid" aria-label="Rate limits">' + entries.map(([key, value]) => '<div class="rate"><span>' + esc(key) + '</span><b>' + esc(typeof value === "object" ? JSON.stringify(value) : value) + '</b></div>').join("") + '</div>'; };
	const queue = (queueCount) => '<div class="worker"><div class="worker-head"><strong>Queue signal</strong><span class="badge ' + (queueCount === null ? "retrying" : "running") + '">' + (queueCount === null ? "console" : "live") + '</span></div><div class="event">' + (queueCount === null ? "Candidate queue is still controlled from the /symphony TUI Queue tab; HTTP snapshot currently exposes active and retry rails." : esc(queueCount) + " candidate issue(s) in snapshot.") + '</div></div>';
	const setRefreshStatus = (tone, text) => { const el = document.querySelector('[data-refresh-status]'); if (!el) return; el.className = 'status-pill ' + tone; el.innerHTML = '<span class="dot"></span>' + esc(text); };
	const updateDashboard = (snapshot) => { latestSnapshot = snapshot; const root = obj(snapshot); const counts = obj(root.counts); const totals = obj(root.codex_totals); const running = arr(root.running); const retrying = arr(root.retrying); const runningCount = num(counts.running) ?? running.length; const retryingCount = num(counts.retrying) ?? retrying.length; const maxAgents = num(root.max_concurrent_agents); const queueCount = num(counts.queued) ?? num(counts.queue); const metrics = document.querySelector('[data-live="metrics"]'); if (metrics) metrics.innerHTML = metric("Agents", String(runningCount) + (maxAgents === null ? "" : " / " + maxAgents), "active workers / configured capacity", "ok") + metric("Retry", String(retryingCount), "runs waiting for backoff or continuation", retryingCount > 0 ? "warn" : "ok") + metric("Queue", queueCount === null ? "—" : String(queueCount), queueCount === null ? "candidate queue is inspected in /symphony" : "candidate issues in snapshot", "") + metric("Tokens", int(num(totals.total_tokens) ?? 0), duration(num(totals.seconds_running) ?? 0) + " agent runtime", ""); const workload = document.querySelector('[data-live="workload"]'); if (workload) workload.innerHTML = '<h2>Workload rail</h2>' + workers(running, "running") + workers(retrying, "retrying"); const control = document.querySelector('[data-live="control-signals"]'); if (control) control.innerHTML = '<h2>Control signals</h2>' + reloadState(root) + rates(root.rate_limits) + queue(queueCount === null ? null : queueCount); const state = document.querySelector('[data-dashboard-state]'); if (state) { const daemonState = str(root.last_reload_error) ? "attention" : "online"; state.className = "status-pill " + daemonState; state.innerHTML = '<span class="dot"></span>' + esc(daemonState); } setRefreshStatus("", "live · refreshed " + new Date().toLocaleTimeString()); };
	const refresh = async () => { try { const response = await fetch(stateUrl, { cache: "no-store" }); if (!response.ok) throw new Error("HTTP " + response.status); updateDashboard(await response.json()); } catch (error) { setRefreshStatus("error", "stale · " + (error && error.message ? error.message : String(error))); } };
	const refreshNow = async () => { setRefreshStatus("", "refresh queued…"); try { await fetch("/api/v1/refresh", { method: "POST" }); await refresh(); } catch (error) { setRefreshStatus("error", "refresh failed · " + (error && error.message ? error.message : String(error))); } };
	const exportSummary = () => { const initial = document.getElementById("initial-dashboard-state")?.textContent || "{}"; const snapshot = latestSnapshot || JSON.parse(initial); const blob = new Blob([redact(JSON.stringify({ exported_at: new Date().toISOString(), snapshot }, null, 2))], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pi-symphony-dashboard-summary.json"; a.click(); URL.revokeObjectURL(a.href); };
	const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; document.body.dataset.theme = theme; localStorage.setItem("pi-symphony-dashboard-theme", theme); };
	document.querySelector('[data-refresh-now]')?.addEventListener("click", refreshNow);
	document.querySelector('[data-export-summary]')?.addEventListener("click", exportSummary);
	document.querySelector('[data-theme-toggle]')?.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "paper" ? "" : "paper"));
	applyTheme(localStorage.getItem("pi-symphony-dashboard-theme") || "");
	window.piSymphonyDashboard = { refresh, refreshNow, updateDashboard, exportSummary, applyTheme, intervalMs: DASHBOARD_REFRESH_INTERVAL_MS };
	setInterval(refresh, DASHBOARD_REFRESH_INTERVAL_MS);
})();
</script>`;
}

type FailureTriage = { category: string; action: string; severity: "success" | "warning" | "error" | "info" };
type AgentMessage = { at: string; text: string; streaming: boolean };

type RunArtifact = { path: string; issueIdentifier: string; status: string; terminalReason: string; workspacePath: string | null; error: string | null; mtimeMs: number; files: string[] };
type LogExcerpt = { label: string; path: string; lines: string[]; latestError: boolean };

function classifyFailure(row: Record<string, unknown>): FailureTriage {
	const text = `${stringValue(row.status)} ${stringValue(row.terminal_reason)} ${stringValue(row.error)} ${stringValue(row.last_error)} ${stringValue(row.last_event)}`.toLowerCase();
	if (/succeeded/.test(text)) return { category: "succeeded", action: "No failure action needed.", severity: "success" };
	if (/config|workflow|front matter|yaml|missing_.*(key|token|kind|command)|invalid_config/.test(text)) return { category: "config", action: "Open Config, fix WORKFLOW.md or .env, then refresh.", severity: "error" };
	if (/tracker|linear|jira|beads|graphql|jql|api key|unauthori[sz]ed|forbidden|rate limit/.test(text)) return { category: "tracker", action: "Check tracker credentials, filters, rate limits, and issue state.", severity: "error" };
	if (/turn_timeout|response_timeout|timed_out|timeout/.test(text)) return { category: "codex timeout", action: "Inspect logs, reduce scope, or raise turn timeout.", severity: "warning" };
	if (/turn_input_required|input required|approval|user input/.test(text)) return { category: "user input required", action: "Make the run non-interactive before retrying.", severity: "warning" };
	if (/after_create|before_run|after_run|hook/.test(text)) return { category: "hook failure", action: "Run the configured hook locally and fix it.", severity: "error" };
	if (/workspace|worktree|checkout|branch|git|permission denied|enoent/.test(text)) return { category: "workspace failure", action: "Check workspace root, git state, and permissions.", severity: "error" };
	if (/stall|stalled|quiet/.test(text)) return { category: "stall", action: "Inspect latest logs and abort/retry if quiet past threshold.", severity: "warning" };
	return { category: text.trim() ? "unknown" : "healthy", action: text.trim() ? "Inspect embedded logs and artifacts." : "No failure signal found.", severity: text.trim() ? "info" : "success" };
}

async function recentRunArtifacts(root: Record<string, unknown>): Promise<RunArtifact[]> {
	const workflowDir = stringValue(root.workflow_dir);
	if (!workflowDir) return [];
	const runsDir = join(workflowDir, ".symphony", "runs");
	try {
		const entries = await readdir(runsDir);
		const rows = await Promise.all(entries.map(async (entry) => {
			const path = join(runsDir, entry);
			try {
				const stats = await stat(path);
				if (!stats.isDirectory()) return null;
				const result = parseJson(await readOptional(join(path, "result.json")));
				const files = (await readdir(path).catch(() => [])).filter((file) => ["prompt.md", "result.json", "events.jsonl", "metadata.json", "debug-bundle.json"].includes(file));
				return { path, issueIdentifier: stringValue(result.issue_identifier) || entry, status: stringValue(result.status) || "in_progress", terminalReason: stringValue(result.terminal_reason), workspacePath: stringValue(result.workspace_path) || null, error: stringValue(result.last_error) || null, mtimeMs: stats.mtimeMs, files };
			} catch { return null; }
		}));
		return rows.filter((row): row is RunArtifact => Boolean(row)).sort((a, b) => (a.status === "failed" ? -1 : 0) - (b.status === "failed" ? -1 : 0) || b.mtimeMs - a.mtimeMs).slice(0, 8);
	} catch { return []; }
}

async function embeddedLogTail(root: Record<string, unknown>): Promise<LogExcerpt[]> {
	const paths = new Map<string, string>();
	for (const row of [...arrayValue(root.running), ...arrayValue(root.retrying)]) {
		const identifier = stringValue(row.issue_identifier) || stringValue(row.issue_id) || "run";
		for (const log of arrayValue(objectValue(row.logs)?.codex_session_logs)) {
			const path = stringValue(log.path);
			if (path) paths.set(`${identifier} ${stringValue(log.label) || "events"}`, path);
		}
		const artifactPath = stringValue(row.artifact_path);
		if (artifactPath) paths.set(`${identifier} events`, join(artifactPath, "events.jsonl"));
	}
	const excerpts: LogExcerpt[] = [];
	for (const [label, path] of [...paths.entries()].slice(0, 4)) {
		const text = await readOptional(path);
		if (!text) continue;
		const lines = redactText(text).split(/\r?\n/).filter(Boolean).slice(-40);
		excerpts.push({ label, path, lines, latestError: lines.some((line) => /\b(error|failed|failure|exception|fatal)\b/i.test(line)) });
	}
	return excerpts;
}

async function readOptional(path: string): Promise<string> {
	try { return await readFile(path, "utf8"); } catch { return ""; }
}

function parseJson(text: string): Record<string, unknown> {
	try { const parsed = JSON.parse(text) as unknown; return objectValue(parsed) ?? {}; } catch { return {}; }
}

function queueTotal(queue: unknown): number | null {
	const root = objectValue(queue);
	if (!root) return null;
	return arrayValue(root.eligible).length + arrayValue(root.notDispatchable).length + arrayValue(root.recentlyChanged).length + arrayValue(root.retrying).length;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(objectValue(row))) : [];
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(Math.floor(totalSeconds), 0);
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatAge(iso: string): string {
	const timestamp = Date.parse(iso);
	return Number.isFinite(timestamp) ? `${formatDuration((Date.now() - timestamp) / 1000)} ago` : "—";
}

function formatAgeMs(ms: number): string {
	return Number.isFinite(ms) ? `${formatDuration((Date.now() - ms) / 1000)} ago` : "—";
}

function formatLooseValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function redactText(text: string): string {
	return text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)[A-Z0-9_]*)=([^\s\"]+)/gi, "$1=[redacted]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
