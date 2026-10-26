import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProjectSync, createTscBridge, transpileSync } from '#bridge';

const timeout = 60_000;

test('native transpilation, queued requests, syntax diagnostics, and clean shutdown', {
	timeout,
}, async () => {
	const bridge = createTscBridge();
	try {
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) => bridge.transpile(`export const value: number = ${i};`)),
		);
		for (const [i, result] of results.entries()) {
			assert.deepEqual(result.diagnostics, []);
			const emitted = await import(`data:text/javascript,${encodeURIComponent(result.outputText)}`);
			assert.equal(emitted.value, i);
		}
		const bad = await bridge.transpile('export const value: = 1;');
		assert.ok(bad.diagnostics.some((d) => d.category === 1));
		const pending = bridge.transpile('export const last: boolean = true;');
		const closed = bridge.close();
		assert.match((await pending).outputText, /last = true/);
		await closed;
		await assert.rejects(bridge.transpile(''), /closed/);
	} finally {
		await bridge.close();
	}
});

test('project diagnostics and evaluated, re-exported literal unions', { timeout }, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'tsc-bridge-'));
	const bridge = createTscBridge({ cwd: dir });
	try {
		await writeFile(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					target: 'ESNext',
					module: 'NodeNext',
					types: [],
					noEmit: true,
				},
				files: ['index.ts'],
			}),
		);
		await writeFile(
			path.join(dir, 'codes.ts'),
			"const values = ['first', '☃'] as const;\nexport type InnerErrorCode = typeof values[number];\n",
		);
		const prefix = "export type { InnerErrorCode as PublicErrorCode } from './codes.js';\n// 😀\n";
		await writeFile(path.join(dir, 'index.ts'), `${prefix}export const wrong: string = 123;\n`);
		const diagnostics = await bridge.checkProject('tsconfig.json');
		const mismatch = diagnostics.find((d) => d.code === 2322);
		assert.ok(mismatch, JSON.stringify(diagnostics));
		assert.equal(mismatch.start, Buffer.byteLength(`${prefix}export const `));
		assert.deepEqual(await bridge.exportedCodeUnions('tsconfig.json', ['index.ts']), [
			{ name: 'PublicErrorCode', codes: ['first', '☃'] },
		]);
		await assert.rejects(
			bridge.exportedCodeUnions('tsconfig.json', ['missing.ts']),
			/not in the project/,
		);
		await writeFile(path.join(dir, 'index.ts'), `${prefix}export const wrong: string = 'fixed';\n`);
		assert.deepEqual(await bridge.checkProject('tsconfig.json'), []);
		const missing = await bridge.checkProject('missing.json');
		assert.ok(missing.some((d) => d.category === 1));
	} finally {
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('cached projects, overrides, chained messages, and synchronous checks', {
	timeout,
}, async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'tsc-bridge-cache-'));
	const bridge = createTscBridge({ cwd: dir });
	try {
		await writeFile(
			path.join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: { strict: true, target: 'ESNext', module: 'NodeNext', types: [] },
				files: ['index.ts'],
			}),
		);
		await writeFile(path.join(dir, 'codes.ts'), "export type AErrorCode = 'a';\n");
		await writeFile(
			path.join(dir, 'index.ts'),
			"export type { AErrorCode } from './codes.js';\nexport const f: (x: string) => void = (x: number) => {};\n",
		);
		await writeFile(path.join(dir, 'loose.ts'), 'export function g(x) { return x; }\n');

		const [chained] = await bridge.checkProject('tsconfig.json');
		assert.ok(chained, 'expected a diagnostic');
		assert.equal(chained.code, 2322);
		assert.ok(chained.children?.length, JSON.stringify(chained));
		assert.equal(
			chained.messageText,
			[
				"Type '(x: number) => void' is not assignable to type '(x: string) => void'.",
				"  Types of parameters 'x' and 'x' are incompatible.",
				"    Type 'string' is not assignable to type 'number'.",
			].join('\n'),
		);
		assert.deepEqual(checkProjectSync('tsconfig.json', { cwd: dir }), [chained]);

		assert.deepEqual(await bridge.exportedCodeUnions('tsconfig.json', ['index.ts']), [
			{ name: 'AErrorCode', codes: ['a'] },
		]);
		await writeFile(path.join(dir, 'codes.ts'), "export type AErrorCode = 'a' | 'b';\n");
		assert.deepEqual(await bridge.exportedCodeUnions('tsconfig.json', ['index.ts']), [
			{ name: 'AErrorCode', codes: ['a', 'b'] },
		]);

		const strict = await bridge.checkProject('tsconfig.json', { files: ['loose.ts'] });
		assert.deepEqual(
			strict.map((d) => [path.basename(d.fileName ?? ''), d.code]),
			[['loose.ts', 7006]],
		);
		const overrides = { files: ['loose.ts'], compilerOptions: { strict: false } };
		assert.deepEqual(await bridge.checkProject('tsconfig.json', overrides), []);
		assert.deepEqual(checkProjectSync('tsconfig.json', { cwd: dir, ...overrides }), []);

		await writeFile(
			path.join(dir, 'index.ts'),
			"export type { AErrorCode } from './codes.js';\nexport const f: (x: string) => void = (x: string) => {};\n",
		);
		assert.deepEqual(await bridge.checkProject('tsconfig.json'), []);
	} finally {
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('a missing executable rejects requests and close without hanging', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'tsc-bridge-missing-'));
	const bridge = createTscBridge({ executable: path.join(dir, 'absent') });
	try {
		await assert.rejects(bridge.transpile('const x = 1;'), /ENOENT/);
		await assert.rejects(bridge.close(), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('synchronous transpilation matches the persistent helper and reports failures', {
	timeout,
}, async () => {
	const bridge = createTscBridge();
	try {
		for (const source of ['export const answer: number = 42;', 'const value: = 1;']) {
			assert.deepEqual(transpileSync(source), await bridge.transpile(source));
		}
		assert.throws(() => transpileSync('', { timeoutMs: 0 }), /timeoutMs/);
		assert.throws(
			() =>
				transpileSync('', {
					executable: fileURLToPath(new URL('./absent-helper', import.meta.url)),
				}),
			/ENOENT/,
		);
	} finally {
		await bridge.close();
	}
});
