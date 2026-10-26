import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { platform } from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
	BridgeRequest,
	BridgeResponse,
	Diagnostic,
	ProjectOverrides,
	TranspileResult,
	TscBridge,
} from '@kjanat/tsc-protocol';
import { clientFor, decodeResponse, readResponse } from '@kjanat/tsc-protocol';

export type {
	CodeUnion,
	Diagnostic,
	ProjectOverrides,
	TranspileResult,
	TscBridge,
} from '@kjanat/tsc-protocol';

function executableOf(executable?: string): string {
	return (
		executable ??
		fileURLToPath(
			new URL(`../bin/tsc-bridge${platform === 'win32' ? '.exe' : ''}`, import.meta.url),
		)
	);
}

const categories = ['warning', 'error', 'suggestion', 'message'] as const;

export function formatDiagnostic(diagnostic: Diagnostic, root: string): string {
	const message = `${categories[diagnostic.category] ?? 'error'} TS${diagnostic.code}: ${diagnostic.messageText}`;
	if (diagnostic.fileName === undefined) return message;
	const lines = readFileSync(diagnostic.fileName)
		.subarray(0, diagnostic.start)
		.toString('utf8')
		.split('\n');
	const column = (lines.at(-1)?.length ?? 0) + 1;
	return `${path.relative(root, diagnostic.fileName)}(${lines.length},${column}): ${message}`;
}

export interface HelperOptions {
	readonly executable?: string;
	readonly cwd?: string;
	readonly timeoutMs?: number;
}

function requestSync(payload: BridgeRequest, options: HelperOptions): BridgeResponse {
	const timeoutMs = options.timeoutMs ?? 60_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
	const result = spawnSync(executableOf(options.executable), [], {
		cwd: options.cwd,
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 16 * 1024 * 1024,
		input: `${JSON.stringify({ id: 1, ...payload })}\n`,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`TypeScript helper exited (${result.signal ?? result.status}): ${result.stderr.trim()}`,
		);
	}
	return readResponse(result.stdout, 1);
}

/** Runs one helper for integrations that require a synchronous transpiler. */
export function transpileSync(
	source: string,
	options: HelperOptions & { readonly fileName?: string } = {},
): TranspileResult {
	const { outputText, diagnostics } = requestSync(
		{ method: 'transpile', source, fileName: options.fileName },
		options,
	);
	return { outputText, diagnostics };
}

/** Runs one helper for integrations that require a synchronous project check. */
export function checkProjectSync(
	configPath: string,
	options: HelperOptions & ProjectOverrides = {},
): readonly Diagnostic[] {
	const { files, compilerOptions, runExternalCode } = options;
	return requestSync(
		{ method: 'checkProject', configPath, files, compilerOptions, runExternalCode },
		options,
	).diagnostics;
}

/** Starts one persistent helper process. Paths passed to it resolve against cwd. */
export function createTscBridge(options: HelperOptions = {}): TscBridge {
	const timeoutMs = options.timeoutMs ?? 60_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
	const executable = executableOf(options.executable);
	const child = spawn(executable, [], { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	const pending = new Map<
		number,
		{
			readonly resolve: (response: BridgeResponse) => void;
			readonly reject: (error: Error) => void;
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextId = 1;
	let closing = false;
	let failure: Error | undefined;
	let stderr = '';
	let resolveExit: () => void = () => {};
	let rejectExit: (error: Error) => void = () => {};
	const exited = new Promise<void>((resolve, reject) => {
		resolveExit = resolve;
		rejectExit = reject;
	});
	// A process can fail before the caller reaches close(). Handle the rejection until close() awaits it.
	void exited.catch(() => {});

	function fail(error: Error): void {
		failure ??= error;
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(failure);
		}
		pending.clear();
	}

	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr = (stderr + chunk).slice(-16_384);
	});
	child.on('error', (error) => {
		fail(error);
		rejectExit(error);
	});
	child.stdin.on('error', fail);
	child.on('close', (code, signal) => {
		lines.close();
		if (code !== 0 || pending.size > 0 || !closing) {
			fail(new Error(`TypeScript helper exited (${signal ?? code}): ${stderr.trim()}`));
		}
		if (failure) rejectExit(failure);
		else resolveExit();
	});
	lines.on('line', (line) => {
		try {
			const decoded = decodeResponse(line);
			const item = pending.get(decoded.id);
			if (!item) throw new Error(`Unexpected response ID: ${decoded.id}`);
			pending.delete(decoded.id);
			clearTimeout(item.timer);
			if (decoded.ok) item.resolve(decoded.response);
			else item.reject(new Error(decoded.error));
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			child.kill();
		}
	});

	function request(payload: BridgeRequest): Promise<BridgeResponse> {
		if (failure) return Promise.reject(failure);
		if (closing) return Promise.reject(new Error('TypeScript bridge is closed'));
		return new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				fail(new Error(`TypeScript request timed out: ${payload.method}`));
				child.kill();
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
				if (error) fail(error);
			});
		});
	}

	return clientFor(request, () => {
		if (!closing) {
			closing = true;
			child.stdin.end();
		}
		return exited;
	});
}
