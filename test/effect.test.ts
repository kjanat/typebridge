import { describe, expect, test } from 'bun:test';
import { Deferred, Effect, Fiber } from 'effect';
import { makeTscBridge } from '@kjanat/tsc-bridge';
import type { Compiler } from '@kjanat/tsc-protocol';
import { decodeMapperMessage, decodeResponse } from '@kjanat/tsc-protocol';
import { makeWasmBridge } from '@kjanat/tsc-wasm';
import { fileURLToPath } from 'node:url';

async function assertClosed(compiler: Compiler): Promise<void> {
	const result = await Effect.runPromise(compiler.transpile('export const value = 1;')).catch(
		(error: unknown) => error,
	);
	expect(result).toBeInstanceOf(Error);
	expect(String(result)).toContain('closed');
}

describe.each([
	['native', makeTscBridge],
	['WASM', makeWasmBridge],
] as const)('%s Effect resource', (_name, acquire) => {
	test('releases the compiler after successful work', async () => {
		const compiler = await Effect.runPromise(
			Effect.scoped(
				acquire().pipe(
					Effect.tap((value) =>
						value
							.transpile('export const answer: number = 42;')
							.pipe(
								Effect.tap((result) => Effect.sync(() => expect(result.diagnostics).toEqual([]))),
							),
					),
				),
			),
		);
		await assertClosed(compiler);
	}, 60_000);

	test('releases the compiler after failure', async () => {
		const holder: { compiler?: Compiler } = {};
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					holder.compiler = yield* acquire();
					return yield* Effect.fail(new Error('Body failed'));
				}),
			),
		).catch((error: unknown) => error);
		expect(String(result)).toContain('Body failed');
		if (holder.compiler === undefined) throw new Error('Compiler acquisition failed');
		await assertClosed(holder.compiler);
	}, 60_000);

	test('releases the compiler when its fiber is interrupted', async () => {
		const ready = Effect.runSync(Deferred.make<Compiler>());
		const fiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const compiler = yield* acquire();
					yield* Deferred.succeed(ready, compiler);
					yield* Effect.never;
				}),
			),
		);
		const compiler = await Effect.runPromise(Deferred.await(ready));
		await Effect.runPromise(Fiber.interrupt(fiber));
		await assertClosed(compiler);
	}, 60_000);
	test('closes its resource after interruption during a project request', async () => {
		const ready = Effect.runSync(Deferred.make<Compiler>());
		const fiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const compiler = yield* acquire();
					yield* Effect.forkChild(
						compiler.checkProject(
							fileURLToPath(new URL('../protocol/tsconfig.json', import.meta.url)),
						),
					);
					yield* Deferred.succeed(ready, compiler);
					yield* Effect.never;
				}),
			),
		);
		const compiler = await Effect.runPromise(Deferred.await(ready));
		await Effect.runPromise(Fiber.interrupt(fiber));
		const result = await Effect.runPromise(compiler.transpile('export const x = 1;')).catch(
			(error: unknown) => error,
		);
		expect(result).toBeInstanceOf(Error);
	}, 60_000);
});

describe('wire schemas', () => {
	test.each([
		['wrong request ID', { id: 'one', outputText: '', diagnostics: [], unions: [] }],
		['missing diagnostics', { id: 1, outputText: '', unions: [] }],
		[
			'wrong diagnostic fields',
			{ id: 1, outputText: '', diagnostics: [{ code: 'invalid' }], unions: [] },
		],
		[
			'wrong code union',
			{ id: 1, outputText: '', diagnostics: [], unions: [{ name: 'ErrorCode', codes: [1] }] },
		],
	] as const)('rejects %s', (_name, value) => {
		expect(() => decodeResponse(JSON.stringify(value))).toThrow();
	});

	test('decodes compiler errors without a success payload', () => {
		expect(decodeResponse('{"id":1,"error":"Invalid project"}')).toEqual({
			id: 1,
			ok: false,
			error: 'Invalid project',
		});
	});

	test('rejects mapper parameters that do not match the requested operation', () => {
		expect(() =>
			decodeMapperMessage(
				'{"jsonrpc":"2.0","id":1,"method":"transform","params":{"projectHandle":42}}',
			),
		).toThrow();
	});
});

test('cleans up a WASM acquisition that does not export the compiler API', async () => {
	const globals = () =>
		Object.getOwnPropertyNames(globalThis).filter((key) => /^tscWasm\d+(Host)?$/.test(key));
	const before = globals();
	const result = await Effect.runPromise(
		Effect.scoped(
			makeWasmBridge({
				wasm: new URL('./fixtures/empty.wasm', import.meta.url),
			}),
		),
	).catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Error);
	expect(globals()).toEqual(before);
});
