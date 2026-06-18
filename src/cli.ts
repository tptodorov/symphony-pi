#!/usr/bin/env node
import { createConsoleLogger } from "./logger.js";
import { SymphonyOrchestrator } from "./orchestrator.js";

interface CliArgs {
	workflowPath?: string;
	once?: string | true;
	port?: number;
	help: boolean;
}

async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(`Usage: pi-symphony [options] [path-to-WORKFLOW.md]

Options:
  --once [ISSUE]     Run one issue then exit. If ISSUE is omitted, run first eligible issue.
  --port PORT       Enable HTTP dashboard/API. Overrides server.port.
  -h, --help        Show help.

Default mode starts the daemon scheduler until SIGINT/SIGTERM.`);
		return 0;
	}
	const orchestrator = new SymphonyOrchestrator(process.cwd(), args.workflowPath, createConsoleLogger(), { portOverride: args.port });
	if (args.once !== undefined) {
		try {
			await orchestrator.runOnce(args.once === true ? undefined : args.once);
			await orchestrator.stop();
			return 0;
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			await orchestrator.stop();
			return 1;
		}
	}
	try {
		await orchestrator.start();
		await waitForSignal();
		await orchestrator.stop();
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		await orchestrator.stop();
		return 1;
	}
}

function parseArgs(argv: string[]): CliArgs {
	const out: CliArgs = { help: false };
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") out.help = true;
		else if (arg === "--port") {
			const value = argv[++i];
			if (!value || !/^\d+$/.test(value)) throw new Error("--port requires an integer");
			out.port = Number(value);
		} else if (arg.startsWith("--port=")) {
			const value = arg.slice("--port=".length);
			if (!/^\d+$/.test(value)) throw new Error("--port requires an integer");
			out.port = Number(value);
		} else if (arg === "--once") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				out.once = next;
				i++;
			} else out.once = true;
		} else if (arg.startsWith("--once=")) {
			out.once = arg.slice("--once=".length) || true;
		} else positional.push(arg);
	}
	out.workflowPath = positional[0];
	return out;
}

function waitForSignal(): Promise<void> {
	return Promise.race([new Promise<void>((resolve) => process.once("SIGINT", () => resolve())), new Promise<void>((resolve) => process.once("SIGTERM", () => resolve()))]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}

export { main, parseArgs };
