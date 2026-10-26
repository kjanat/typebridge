import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { BridgeRequest, BridgeResponse, Compiler, TscBridge } from '@kjanat/tsc-protocol';
import { compilerFor, encodeRequest, promiseClientFor, readResponse } from '@kjanat/tsc-protocol';
import { Effect, Exit, Fiber, FiberSet, Scope } from 'effect';
import { createHost } from '#host';
import initBridge from '../bin/tsc-bridge.wasm?init';

export type {
	CodeUnion,
	Compiler,
	Diagnostic,
	ProjectOverrides,
	TranspileResult,
	TscBridge,
} from '@kjanat/tsc-protocol';

interface GoRuntime {
	env: Record<string, string>;
	readonly importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
	readonly _scheduledTimeouts: Map<number, ReturnType<typeof setTimeout>>;
}

interface Exported {
	invoke(input: string): Promise<string>;
	close(): void;
}

export interface WasmBridgeOptions {
	/** The compiled bridge. Defaults to `bin/tsc-bridge.wasm`, which `build.ts` writes. */
	readonly wasm?: string | URL;
}

let instances = 0;

async function goRuntime(): Promise<new () => GoRuntime> {
	if (Reflect.get(globalThis, 'fs') === undefined) Reflect.set(globalThis, 'fs', fs);
	await import(new URL('../bin/wasm_exec.js', import.meta.url).href);
	const Go: (new () => GoRuntime) | undefined = Reflect.get(globalThis, 'Go');
	if (Go === undefined) throw new Error('wasm_exec.js did not define Go');
	return Go;
}

/** Acquires a WASM compiler whose runtime and requests share an Effect scope. */
export function makeWasmBridge(
	options: WasmBridgeOptions = {},
): Effect.Effect<Compiler, Error, Scope.Scope> {
	return Effect.gen(function* () {
		const host = yield* Effect.acquireRelease(Effect.sync(createHost), (value) =>
			Effect.sync(() => value.stop()),
		);
		const Go = yield* Effect.tryPromise({
			try: goRuntime,
			catch: (cause) => new Error('Could not load the Go runtime', { cause }),
		});
		const go = new Go();
		const name = `tscWasm${++instances}`;
		go.env = { ...go.env, TSC_WASM_GLOBAL: name };
		Reflect.set(globalThis, `${name}Host`, { spawn: host.spawn });
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				for (const timer of go._scheduledTimeouts.values()) clearTimeout(timer);
				go._scheduledTimeouts.clear();
				Reflect.deleteProperty(globalThis, name);
				Reflect.deleteProperty(globalThis, `${name}Host`);
			}),
		);
		const requests = yield* FiberSet.make<BridgeResponse, Error>();
		const instance = yield* Effect.tryPromise({
			try: async () =>
				options.wasm === undefined
					? initBridge(go.importObject)
					: (await WebAssembly.instantiate(await readFile(options.wasm), go.importObject)).instance,
			catch: (cause) => new Error('Could not instantiate the compiler WASM module', { cause }),
		});
		const running = go.run(instance);
		const runtime = yield* Effect.forkScoped(
			Effect.tryPromise({
				try: () => running,
				catch: (cause) => new Error('Compiler WASM runtime failed', { cause }),
			}),
			{ startImmediately: true },
		);
		const api: Exported | undefined = Reflect.get(globalThis, name);
		if (api === undefined) return yield* Effect.fail(new Error('The WASM bridge did not start'));
		let nextId = 1;
		let closing = false;
		const close = yield* Effect.cached(
			Effect.gen(function* () {
				closing = true;
				yield* FiberSet.awaitEmpty(requests);
				yield* Effect.sync(() => {
					host.stop();
					api.close();
				});
				yield* Fiber.join(runtime);
			}),
		);
		yield* Effect.addFinalizer(() => Effect.orDie(close));

		const request = (payload: BridgeRequest): Effect.Effect<BridgeResponse, Error> =>
			Effect.gen(function* () {
				if (closing) return yield* Effect.fail(new Error('TypeScript bridge is closed'));
				const id = nextId++;
				const operation = Effect.tryPromise({
					try: () => api.invoke(encodeRequest(id, payload)),
					catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
				}).pipe(
					Effect.flatMap((text) =>
						Effect.try({
							try: () => readResponse(text, id),
							catch: (cause) => new Error('Invalid compiler response', { cause }),
						}),
					),
					Effect.withSpan('typebridge.request', { attributes: { method: payload.method } }),
				);
				const fiber = yield* FiberSet.run(
					requests,
					Effect.raceFirst(
						operation,
						Fiber.join(runtime).pipe(
							Effect.andThen(
								Effect.fail(new Error('Compiler WASM runtime exited during a request')),
							),
						),
					),
				);
				return yield* Fiber.join(fiber);
			});
		return compilerFor(request, close);
	});
}

/** Promise facade with explicit close for callers outside Effect. */
export async function createWasmBridge(options: WasmBridgeOptions = {}): Promise<TscBridge> {
	const scope = Scope.makeUnsafe();
	try {
		const compiler = await Effect.runPromise(Scope.provide(makeWasmBridge(options), scope));
		return promiseClientFor({ ...compiler, close: Scope.close(scope, Exit.void) });
	} catch (error) {
		await Effect.runPromise(Scope.close(scope, Exit.fail(error)));
		throw error;
	}
}
