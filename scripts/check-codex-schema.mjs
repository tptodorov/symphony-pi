#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

await (async () => {
	const helper = {
		collectJsonFiles: async (dir) => {
			const out = [];
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) out.push(...(await helper.collectJsonFiles(path)));
				else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
			}
			return out;
		},
		findSchema: (schemas, pattern) => schemas.find(({ file, json }) => pattern.test(file) || pattern.test(JSON.stringify(json))),
		assertSchemaMentions: (schema, fields, label) => {
			const text = JSON.stringify(schema.json);
			const missing = fields.filter((field) => !text.includes(`"${field}"`));
			if (missing.length > 0) throw new Error(`${label} schema ${schema.file} is missing expected fields: ${missing.join(", ")}`);
		},
		assertThreadStartAcceptsDynamicTools: async (codex) => {
			const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-codex-dynamic-tools-"));
			const proc = spawn(codex, ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
			const rl = createInterface({ input: proc.stdout });
			let nextId = 1;
			const send = (method, params, notify = false) => {
				const message = notify ? { method, params } : { method, id: nextId++, params };
				proc.stdin.write(`${JSON.stringify(message)}\n`);
				return message.id;
			};
			try {
				const result = await new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("dynamic_tools thread/start probe timed out")), 10_000);
					proc.on("error", reject);
					rl.on("line", (line) => {
						const message = JSON.parse(line);
						if (message.id === 1) {
							send("initialized", {}, true);
							send("thread/start", {
								cwd,
								serviceName: "pi_symphony_schema_probe",
								dynamic_tools: [helper.linearGraphqlToolSpec()],
							});
						} else if (message.id === 2) {
							clearTimeout(timer);
							if (message.error) reject(new Error(`dynamic_tools thread/start rejected: ${message.error.message ?? JSON.stringify(message.error)}`));
							else resolve(message.result);
						}
					});
					send("initialize", { clientInfo: { name: "pi_symphony_schema_probe", version: "0.1.0" } });
				});
				if (!result?.thread?.id) throw new Error("dynamic_tools thread/start probe did not return thread.id");
			} finally {
				rl.close();
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 2_000).unref();
				await rm(cwd, { recursive: true, force: true });
			}
		},
		linearGraphqlToolSpec: () => ({
			name: "linear_graphql",
			description: "Execute one Linear GraphQL query or mutation using configured Linear auth.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" }, variables: { type: "object", additionalProperties: true } },
				required: ["query"],
				additionalProperties: false,
			},
			deferLoading: false,
		}),
		assertAnySchemaMentions: (schemas, fields, label) => {
			const found = schemas.find((schema) => fields.every((field) => JSON.stringify(schema.json).includes(`"${field}"`)));
			if (!found) throw new Error(`could not find generated ${label} schema mentioning: ${fields.join(", ")}`);
		},
	};

	const codex = process.env.CODEX_BIN ?? "codex";
	if (spawnSync(codex, ["--version"], { encoding: "utf8" }).error) {
		console.log(`[skip] codex binary not found (${codex}); install Codex CLI or set CODEX_BIN to run this smoke.`);
		process.exit(0);
	}

	const outDir = await mkdtemp(join(tmpdir(), "pi-symphony-codex-schema-"));
	try {
		const generated = spawnSync(codex, ["app-server", "generate-json-schema", "--out", outDir], { encoding: "utf8" });
		if (generated.status !== 0) {
			const text = `${generated.stdout}\n${generated.stderr}`;
			if (/unknown|unrecognized|not found|No such command/i.test(text)) {
				console.log(`[skip] installed codex does not expose app-server schema generation: ${text.trim().slice(0, 500)}`);
				process.exit(0);
			}
			throw new Error(`codex schema generation failed: ${text.trim()}`);
		}

		const files = await helper.collectJsonFiles(outDir);
		if (files.length === 0) throw new Error(`codex schema generation produced no JSON files in ${outDir}`);
		const schemas = [];
		for (const file of files) schemas.push({ file, json: JSON.parse(await readFile(file, "utf8")) });

		const threadSchema = helper.findSchema(schemas, /ThreadStartParams|thread\/start/i);
		const turnSchema = helper.findSchema(schemas, /TurnStartParams|turn\/start/i);
		const clientRequestSchema = helper.findSchema(schemas, /(?:^|[/\\])ClientRequest\.json$/i);
		const serverRequestSchema = helper.findSchema(schemas, /(?:^|[/\\])ServerRequest\.json$/i);
		if (!threadSchema) throw new Error("could not locate ThreadStartParams/thread-start schema in generated Codex schemas");
		if (!turnSchema) throw new Error("could not locate TurnStartParams/turn-start schema in generated Codex schemas");
		if (!clientRequestSchema) throw new Error("could not locate ClientRequest schema in generated Codex schemas");
		if (!serverRequestSchema) throw new Error("could not locate ServerRequest schema in generated Codex schemas");

		helper.assertSchemaMentions(threadSchema, ["cwd", "approvalPolicy", "sandbox"], "thread/start");
		helper.assertSchemaMentions(turnSchema, ["threadId", "cwd", "input", "approvalPolicy", "sandboxPolicy"], "turn/start");
		helper.assertSchemaMentions(clientRequestSchema, ["thread/name/set", "ThreadSetNameParams", "name", "threadId"], "thread/name/set");
		helper.assertSchemaMentions(serverRequestSchema, ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "item/tool/call", "DynamicToolCallParams"], "server requests");
		helper.assertAnySchemaMentions(schemas, ["DynamicToolSpec", "inputSchema", "description"], "dynamic tool spec");
		helper.assertAnySchemaMentions(schemas, ["DynamicToolCallResponse", "contentItems", "success"], "dynamic tool response");
		helper.assertAnySchemaMentions(schemas, ["CommandExecutionRequestApprovalResponse", "decision", "accept"], "command approval response");
		helper.assertAnySchemaMentions(schemas, ["FileChangeRequestApprovalResponse", "decision", "accept"], "file-change approval response");
		helper.assertAnySchemaMentions(schemas, ["PermissionsRequestApprovalResponse", "permissions", "scope"], "permissions approval response");
		await helper.assertThreadStartAcceptsDynamicTools(codex);
		console.log(`[ok] Codex app-server generated schemas and dynamic tool startup probe are compatible: ${threadSchema.file}, ${turnSchema.file}`);
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
})();
