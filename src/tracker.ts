import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Issue, Logger, SymphonyConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface TrackerAdapter {
	fetchCandidateIssues(signal?: AbortSignal): Promise<Issue[]>;
	fetchIssuesByStates(stateNames: string[], signal?: AbortSignal): Promise<Issue[]>;
	fetchIssueStatesByIds(issueIds: string[], signal?: AbortSignal): Promise<Issue[]>;
}

export function createTrackerAdapter(getConfig: () => SymphonyConfig, logger: Logger): TrackerAdapter {
	const kind = getConfig().tracker.kind;
	if (kind === "linear") return new LinearTrackerClient(getConfig, logger);
	if (kind === "jira") return new JiraTrackerClient(getConfig, logger);
	if (kind === "beads") return new BeadsTrackerClient(getConfig, logger);
	throw new Error(`unsupported_tracker_kind: ${kind}`);
}

interface LinearPageInfo {
	hasNextPage?: boolean;
	endCursor?: string | null;
}

export class LinearTrackerClient implements TrackerAdapter {
	constructor(
		private readonly getConfig: () => SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async fetchCandidateIssues(signal?: AbortSignal): Promise<Issue[]> {
		const config = this.getConfig();
		return this.fetchIssuesByFilter(config.tracker.activeStates, signal);
	}

	async fetchIssuesByStates(stateNames: string[], signal?: AbortSignal): Promise<Issue[]> {
		if (stateNames.length === 0) return [];
		return this.fetchIssuesByFilter(stateNames, signal);
	}

	async fetchIssueStatesByIds(issueIds: string[], signal?: AbortSignal): Promise<Issue[]> {
		if (issueIds.length === 0) return [];
		const query = `query SymphonyIssueStates($ids: [ID!]) {
  issues(filter: { id: { in: $ids } }, first: 100) {
    nodes {
      id
      identifier
      title
      priority
      branchName
      url
      createdAt
      updatedAt
      state { name }
      labels { nodes { name } }
      inverseRelations { nodes { type issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
    }
  }
}`;
		const data = await this.graphql(query, { ids: issueIds }, signal);
		const nodes = data?.issues?.nodes;
		if (!Array.isArray(nodes)) throw new Error("linear_unknown_payload: issues.nodes missing");
		return nodes.map(normalizeLinearIssue).filter(Boolean) as Issue[];
	}

	async linearGraphql(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<{ success: boolean; body?: unknown; error?: string }> {
		try {
			if (typeof query !== "string" || !query.trim()) return { success: false, error: "query must be non-empty" };
			if (!isPlainObject(variables)) return { success: false, error: "variables must be an object" };
			if (countGraphqlOperations(query) !== 1) return { success: false, error: "query must contain exactly one GraphQL operation" };
			const body = await this.graphqlRaw(query, variables, signal);
			return { success: !Array.isArray(body.errors), body };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	}

	private async fetchIssuesByFilter(states: string[], signal?: AbortSignal): Promise<Issue[]> {
		const query = `query SymphonyIssues($projectSlug: String!, $states: [String!], $first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $states } } }
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      branchName
      url
      createdAt
      updatedAt
      state { name }
      labels { nodes { name } }
      inverseRelations { nodes { type issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
		const all: Issue[] = [];
		let after: string | null = null;
		for (;;) {
			const data = await this.graphql(query, { projectSlug: this.getConfig().tracker.projectSlug, states, first: 50, after }, signal);
			const issues = data?.issues;
			const nodes = issues?.nodes;
			if (!Array.isArray(nodes)) throw new Error("linear_unknown_payload: issues.nodes missing");
			all.push(...(nodes.map(normalizeLinearIssue).filter(Boolean) as Issue[]));
			const pageInfo = issues?.pageInfo as LinearPageInfo | undefined;
			if (!pageInfo?.hasNextPage) break;
			if (!pageInfo.endCursor) throw new Error("linear_missing_end_cursor");
			after = pageInfo.endCursor;
		}
		return all;
	}

	private async graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		const body = await this.graphqlRaw(query, variables, signal);
		if (Array.isArray(body.errors)) throw new Error(`linear_graphql_errors: ${JSON.stringify(body.errors)}`);
		return body.data;
	}

	private async graphqlRaw(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		const config = this.getConfig();
		if (!config.tracker.apiKey) throw new Error("missing_tracker_api_key");
		const timeout = AbortSignal.timeout(30_000);
		const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(config.tracker.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: config.tracker.apiKey,
				},
				body: JSON.stringify({ query, variables }),
				signal: combinedSignal,
			});
		} catch (error) {
			throw new Error(`linear_api_request: ${errorMessage(error)}`);
		}
		if (!response.ok) throw new Error(`linear_api_status: ${response.status}`);
		try {
			return await response.json();
		} catch (error) {
			throw new Error(`linear_unknown_payload: ${errorMessage(error)}`);
		}
	}
}

export class JiraTrackerClient implements TrackerAdapter {
	constructor(
		private readonly getConfig: () => SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async fetchCandidateIssues(signal?: AbortSignal): Promise<Issue[]> {
		const config = this.getConfig();
		const states = config.tracker.activeStates.map((state) => `\"${escapeJql(state)}\"`).join(", ");
		const jql = config.tracker.jiraJql ?? `project = ${escapeJql(config.tracker.jiraProjectKey)} AND status in (${states}) ORDER BY priority ASC, created ASC`;
		return this.searchJql(jql, signal);
	}

	async fetchIssuesByStates(stateNames: string[], signal?: AbortSignal): Promise<Issue[]> {
		if (stateNames.length === 0) return [];
		const config = this.getConfig();
		const states = stateNames.map((state) => `\"${escapeJql(state)}\"`).join(", ");
		const projectFilter = config.tracker.jiraProjectKey ? `project = ${escapeJql(config.tracker.jiraProjectKey)} AND ` : "";
		return this.searchJql(`${projectFilter}status in (${states}) ORDER BY created ASC`, signal);
	}

	async fetchIssueStatesByIds(issueIds: string[], signal?: AbortSignal): Promise<Issue[]> {
		if (issueIds.length === 0) return [];
		const keys = issueIds.map((id) => `\"${escapeJql(id)}\"`).join(", ");
		return this.searchJql(`key in (${keys})`, signal);
	}

	private async searchJql(jql: string, signal?: AbortSignal): Promise<Issue[]> {
		const all: Issue[] = [];
		let nextPageToken: string | undefined;
		const maxResults = this.getConfig().tracker.jiraPageSize ?? 50;
		const fields = ["summary", "description", "priority", "status", "labels", "created", "updated", "issuelinks"];
		for (;;) {
			const payload: Record<string, unknown> = { jql, maxResults, fields };
			if (nextPageToken) payload.nextPageToken = nextPageToken;
			const body = await this.requestJson("/rest/api/3/search/jql", {
				method: "POST",
				body: JSON.stringify(payload),
				signal,
			});
			if (!Array.isArray(body.issues)) throw new Error("jira_unknown_payload: issues missing");
			all.push(...(body.issues.map(normalizeJiraIssue).filter(Boolean) as Issue[]));
			const token = typeof body.nextPageToken === "string" && body.nextPageToken.length > 0 ? body.nextPageToken : undefined;
			if (body.issues.length === 0 || body.isLast === true || !token) break;
			nextPageToken = token;
		}
		return all;
	}

	private async requestJson(path: string, options: { method: string; body?: string; signal?: AbortSignal }): Promise<any> {
		const config = this.getConfig();
		const endpoint = config.tracker.endpoint.replace(/\/$/, "");
		const auth = Buffer.from(`${config.tracker.jiraEmail}:${config.tracker.jiraApiToken}`).toString("base64");
		const timeout = AbortSignal.timeout(30_000);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetch(`${endpoint}${path}`, {
				method: options.method,
				headers: { authorization: `Basic ${auth}`, accept: "application/json", "content-type": "application/json" },
				body: options.body,
				signal,
			});
		} catch (error) {
			throw new Error(`jira_api_request: ${errorMessage(error)}`);
		}
		if (!response.ok) throw new Error(`jira_api_status: ${response.status}`);
		return response.json();
	}
}

export class BeadsTrackerClient implements TrackerAdapter {
	constructor(
		private readonly getConfig: () => SymphonyConfig,
		private readonly logger: Logger,
	) {}

	async fetchCandidateIssues(signal?: AbortSignal): Promise<Issue[]> {
		const command = this.getConfig().tracker.beadsReadyCommand;
		return this.runJsonCommand(command, signal);
	}

	async fetchIssuesByStates(stateNames: string[], signal?: AbortSignal): Promise<Issue[]> {
		if (stateNames.length === 0) return [];
		const command = `${this.getConfig().tracker.beadsCommand} list --json`;
		const issues = await this.runJsonCommand(command, signal);
		const wanted = new Set(stateNames.map((state) => state.toLowerCase()));
		return issues.filter((issue) => wanted.has(issue.state.toLowerCase()));
	}

	async fetchIssueStatesByIds(issueIds: string[], signal?: AbortSignal): Promise<Issue[]> {
		const issues = await Promise.all(issueIds.map((id) => this.runJsonCommand(`${this.getConfig().tracker.beadsCommand} show ${shellQuote(id)} --json`, signal)));
		return issues.flat();
	}

	private async runJsonCommand(command: string, signal?: AbortSignal): Promise<Issue[]> {
		try {
			const { stdout } = await execFileAsync("sh", ["-lc", command], { cwd: this.getConfig().workflowDir, signal, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
			const parsed = JSON.parse(stdout || "[]");
			const rows = Array.isArray(parsed) ? parsed : [parsed];
			return rows.map(normalizeBeadIssue).filter(Boolean) as Issue[];
		} catch (error) {
			throw new Error(`beads_command_failed: ${errorMessage(error)}`);
		}
	}
}

export function normalizeLinearIssue(node: any): Issue | null {
	if (!node || typeof node.id !== "string" || typeof node.identifier !== "string" || typeof node.title !== "string") return null;
	const labels = Array.isArray(node.labels?.nodes)
		? node.labels.nodes.map((label: any) => (typeof label?.name === "string" ? label.name.toLowerCase() : null)).filter(Boolean)
		: [];
	const inverse = Array.isArray(node.inverseRelations?.nodes) ? node.inverseRelations.nodes : [];
	const blocked_by = inverse
		.filter((rel: any) => String(rel?.type ?? "").toLowerCase() === "blocks")
		.map((rel: any) => {
			const blocker = rel.issue ?? rel.relatedIssue ?? {};
			return {
				id: typeof blocker.id === "string" ? blocker.id : null,
				identifier: typeof blocker.identifier === "string" ? blocker.identifier : null,
				state: typeof blocker.state?.name === "string" ? blocker.state.name : null,
			};
		});
	const priority = typeof node.priority === "number" && Number.isInteger(node.priority) ? node.priority : null;
	return {
		id: node.id,
		identifier: node.identifier,
		title: node.title,
		description: typeof node.description === "string" ? node.description : null,
		priority,
		state: typeof node.state?.name === "string" ? node.state.name : "",
		branch_name: typeof node.branchName === "string" ? node.branchName : null,
		url: typeof node.url === "string" ? node.url : null,
		labels,
		blocked_by,
		created_at: typeof node.createdAt === "string" ? node.createdAt : null,
		updated_at: typeof node.updatedAt === "string" ? node.updatedAt : null,
	};
}

export function normalizeJiraIssue(node: any): Issue | null {
	if (!node || typeof node.key !== "string") return null;
	const fields = node.fields ?? {};
	const blocked_by = Array.isArray(fields.issuelinks)
		? fields.issuelinks
				.filter((link: any) => String(link?.type?.name ?? "").toLowerCase() === "blocks" && link.inwardIssue)
				.map((link: any) => ({
					id: typeof link.inwardIssue?.key === "string" ? link.inwardIssue.key : null,
					identifier: typeof link.inwardIssue?.key === "string" ? link.inwardIssue.key : null,
					state: typeof link.inwardIssue?.fields?.status?.name === "string" ? link.inwardIssue.fields.status.name : null,
				}))
		: [];
	return {
		id: node.key,
		identifier: node.key,
		title: typeof fields.summary === "string" ? fields.summary : node.key,
		description: jiraDescriptionToText(fields.description),
		priority: jiraPriorityToNumber(fields.priority),
		state: typeof fields.status?.name === "string" ? fields.status.name : "",
		branch_name: null,
		url: typeof node.self === "string" ? node.self : null,
		labels: Array.isArray(fields.labels) ? fields.labels.filter((label: unknown): label is string => typeof label === "string").map((label: string) => label.toLowerCase()) : [],
		blocked_by,
		created_at: typeof fields.created === "string" ? fields.created : null,
		updated_at: typeof fields.updated === "string" ? fields.updated : null,
	};
}

export function normalizeBeadIssue(row: any): Issue | null {
	if (!row || typeof row !== "object") return null;
	const id = stringFirst(row, ["id", "key", "identifier"]);
	if (!id) return null;
	const title = stringFirst(row, ["title", "summary", "name"]) ?? id;
	const state = stringFirst(row, ["status", "state"]) ?? "open";
	const labelsRaw = row.labels ?? row.tags ?? [];
	return {
		id,
		identifier: stringFirst(row, ["identifier", "key", "id"]) ?? id,
		title,
		description: stringFirst(row, ["description", "body", "notes"]),
		priority: typeof row.priority === "number" && Number.isInteger(row.priority) ? row.priority : null,
		state,
		branch_name: null,
		url: stringFirst(row, ["url"]),
		labels: Array.isArray(labelsRaw) ? labelsRaw.filter((label: unknown): label is string => typeof label === "string").map((label: string) => label.toLowerCase()) : [],
		blocked_by: Array.isArray(row.blocked_by)
			? row.blocked_by.map((blocker: any) => ({
					id: stringFirst(blocker, ["id"]),
					identifier: stringFirst(blocker, ["identifier", "key", "id"]),
					state: stringFirst(blocker, ["state", "status"]),
				}))
			: [],
		created_at: stringFirst(row, ["created_at", "createdAt", "created"]),
		updated_at: stringFirst(row, ["updated_at", "updatedAt", "updated"]),
	};
}

function jiraDescriptionToText(value: any): string | null {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	const parts: string[] = [];
	const visit = (node: any) => {
		if (!node || typeof node !== "object") return;
		if (typeof node.text === "string") parts.push(node.text);
		if (Array.isArray(node.content)) for (const child of node.content) visit(child);
	};
	visit(value);
	return parts.length > 0 ? parts.join(" ") : null;
}

function jiraPriorityToNumber(priority: any): number | null {
	if (typeof priority?.id === "string" && /^\d+$/.test(priority.id)) return Number(priority.id);
	if (typeof priority?.name === "string") {
		const map: Record<string, number> = { highest: 1, high: 2, medium: 3, low: 4, lowest: 5 };
		return map[priority.name.toLowerCase()] ?? null;
	}
	return null;
}

function stringFirst(row: any, keys: string[]): string | null {
	for (const key of keys) if (typeof row?.[key] === "string") return row[key];
	return null;
}

function escapeJql(value: string): string {
	return value.replace(/([\\"])/g, "\\$1");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function countGraphqlOperations(query: string): number {
	const stripped = query.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, "").replace(/"(?:\\.|[^"\\])*"/g, "");
	return (stripped.match(/\b(query|mutation|subscription)\b/g) ?? []).length || (stripped.trim().startsWith("{") ? 1 : 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
