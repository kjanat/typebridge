import { describe, expect, test } from 'bun:test';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeWasmBridge } from '@kjanat/tsc-wasm';
import type { Compiler } from '@kjanat/tsc-protocol';
import { Deferred, Effect, Exit, Fiber } from 'effect';

async function within<A>(
	operation: Promise<A>,
	milliseconds: number,
	message = 'WASM scope teardown timed out',
): Promise<A> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const globals = () =>
	Object.getOwnPropertyNames(globalThis).filter((key) => /^tscWasm\d+(Host)?$/.test(key));

describe.each(['interruption', 'failure'] as const)('WASM scope %s', (mode) => {
	test('stops a request waiting on an unresponsive mapper', async () => {
		await mkdir('.cache', { recursive: true });
		const directory = await mkdtemp(resolve('.cache/wasm-teardown-'));
		const mapper = join(directory, 'node_modules/typebridge-stalled-mapper');
		await mkdir(mapper, { recursive: true });
		await writeFile(
			join(mapper, 'server.mjs'),
			new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(
				await readFile(new URL('./fixtures/stalled-mapper/server.ts', import.meta.url), 'utf8'),
			),
		);
		await writeFile(
			join(mapper, 'package.json'),
			JSON.stringify({
				name: 'typebridge-stalled-mapper',
				type: 'module',
				typescript: { contentMapper: { exec: ['node', 'server.mjs'] } },
			}),
		);
		const config = join(directory, 'tsconfig.json');
		await writeFile(join(directory, 'input.stall'), 'export const value = 1;');
		await writeFile(
			config,
			JSON.stringify({
				compilerOptions: { noEmit: true, types: [] },
				files: ['input.stall'],
				contentMappers: [{ package: 'typebridge-stalled-mapper', extensions: ['.stall'] }],
			}),
		);
		const watcher = watch(mapper);
		const mapperReady = new Promise<void>((ready) => {
			watcher.on('change', (_event, fileName) => {
				if (fileName === 'ready') ready();
			});
		});
		const before = globals();
		const acquired = Effect.runSync(Deferred.make<Compiler>());
		const finish = Effect.runSync(Deferred.make<void, Error>());
		const fiber = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const compiler = yield* makeWasmBridge();
					yield* Deferred.succeed(acquired, compiler);
					yield* Effect.forkChild(compiler.checkProject(config, { runExternalCode: true }));
					yield* Deferred.await(finish);
				}),
			),
		);
		let pid: number | undefined;
		try {
			const compiler = await within(
				Effect.runPromise(Deferred.await(acquired)),
				5_000,
				'Compiler acquisition timed out',
			);
			await within(mapperReady, 5_000, 'Mapper did not receive a request');
			pid = Number(await readFile(join(mapper, 'ready'), 'utf8'));
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			if (mode === 'interruption') {
				await within(Effect.runPromise(Fiber.interrupt(fiber)), 1_000);
			} else {
				Effect.runSync(Deferred.fail(finish, new Error('Body failed')));
				await within(Effect.runPromise(Fiber.await(fiber)), 1_000);
			}
			expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
			expect(globals()).toEqual(before);
			const result = await Effect.runPromise(compiler.transpile('const x = 1;')).catch(
				(error: unknown) => error,
			);
			expect(String(result)).toContain('closed');
		} finally {
			watcher.close();
			if (pid !== undefined) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// The compiler may already have stopped the mapper.
				}
			}
			await Effect.runPromise(Fiber.interrupt(fiber));
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
