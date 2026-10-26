import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { platform } from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type {
	BridgeRequest,
	BridgeResponse,
	Compiler,
	Diagnostic,
	ProjectOverrides,
	TranspileResult,
	TscBridge,
} from '@kjanat/tsc-protocol';
import {
	compilerFor,
	decodeResponse,
	encodeRequest,
	promiseClientFor,
	readResponse,
} from '@kjanat/tsc-protocol';
import { Deferred, Effect, Exit, Scope } from 'effect';

export type {
	CodeUnion,
	Compiler,
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
		input: `${encodeRequest(1, payload)}\n`,
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

/** Acquires a compiler whose process is closed with its Effect scope. */
export function makeTscBridge(
	options: HelperOptions = {},
): Effect.Effect<Compiler, Error, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.gen(function* () {
			const timeoutMs = options.timeoutMs ?? 60_000;
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
				return yield* Effect.fail(new Error('timeoutMs must be positive'));
			const exited = yield* Deferred.make<void, Error>();
			const child = yield* Effect.try({
				try: () =>
					spawn(executableOf(options.executable), [], {
						cwd: options.cwd,
						stdio: ['pipe', 'pipe', 'pipe'],
					}),
				catch: (cause) => new Error('Could not start TypeScript helper', { cause }),
			});
			const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
			const pending = new Map<number, Deferred.Deferred<BridgeResponse, Error>>();
			let nextId = 1;
			let closing = false;
			let failure: Error | undefined;
			let stderr = '';

			function fail(error: Error): void {
				failure ??= error;
				for (const item of pending.values()) Effect.runSync(Deferred.fail(item, failure));
				pending.clear();
			}

			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				stderr = (stderr + chunk).slice(-16_384);
			});
			child.on('error', (error) => {
				fail(error);
				Effect.runSync(Deferred.fail(exited, error));
			});
			child.stdin.on('error', fail);
			child.on('close', (code, signal) => {
				lines.close();
				if (code !== 0 || pending.size > 0 || !closing)
					fail(new Error(`TypeScript helper exited (${signal ?? code}): ${stderr.trim()}`));
				Effect.runSync(
					failure === undefined
						? Deferred.succeed(exited, undefined)
						: Deferred.fail(exited, failure),
				);
			});
			lines.on('line', (line) => {
				try {
					const decoded = decodeResponse(line);
					const item = pending.get(decoded.id);
					if (item === undefined) throw new Error(`Unexpected response ID: ${decoded.id}`);
					pending.delete(decoded.id);
					Effect.runSync(
						decoded.ok
							? Deferred.succeed(item, decoded.response)
							: Deferred.fail(item, new Error(decoded.error)),
					);
				} catch (cause) {
					fail(cause instanceof Error ? cause : new Error(String(cause)));
					child.kill();
				}
			});

			const request = (payload: BridgeRequest): Effect.Effect<BridgeResponse, Error> =>
				Effect.gen(function* () {
					if (failure !== undefined) return yield* Effect.fail(failure);
					if (closing) return yield* Effect.fail(new Error('TypeScript bridge is closed'));
					const id = nextId++;
					const input = yield* Effect.try({
						try: () => encodeRequest(id, payload),
						catch: (cause) => new Error('Invalid compiler request', { cause }),
					});
					const response = yield* Deferred.make<BridgeResponse, Error>();
					pending.set(id, response);
					child.stdin.write(`${input}\n`, (error) => {
						if (error) fail(error);
					});
					return yield* Deferred.await(response).pipe(
						Effect.timeoutOrElse({
							duration: timeoutMs,
							orElse: () =>
								Effect.suspend(() => {
									const error = new Error(`TypeScript request timed out: ${payload.method}`);
									fail(error);
									child.kill();
									return Effect.fail(error);
								}),
						}),
						Effect.onInterrupt(() =>
							Effect.sync(() => {
								fail(new Error(`TypeScript request interrupted: ${payload.method}`));
								child.kill();
							}),
						),
						Effect.ensuring(
							Effect.sync(() => {
								pending.delete(id);
							}),
						),
						Effect.withSpan('typebridge.request', { attributes: { method: payload.method } }),
					);
				});

			const close = Effect.suspend(() => {
				if (!closing) {
					closing = true;
					child.stdin.end();
				}
				return Deferred.await(exited);
			});
			return compilerFor(request, close);
		}),
		(compiler) => Effect.orDie(compiler.close),
	);
}

/** Promise facade with explicit close for callers outside Effect. */
export function createTscBridge(options: HelperOptions = {}): TscBridge {
	const scope = Scope.makeUnsafe();
	const compiler = Effect.runSync(Scope.provide(makeTscBridge(options), scope));
	return promiseClientFor({ ...compiler, close: Scope.close(scope, Exit.void) });
}
