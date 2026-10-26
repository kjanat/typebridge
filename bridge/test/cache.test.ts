import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { CodeUnion, Diagnostic, ProjectOverrides } from '#bridge';
import { checkProjectSync, createTscBridge } from '#bridge';

const timeout = 60_000;

type Located = readonly [file: string, code: number];

function located(diagnostics: readonly Diagnostic[]): readonly Located[] {
	return diagnostics.map((d) => [path.basename(d.fileName ?? ''), d.code] as const);
}

async function project(): Promise<{
	readonly dir: string;
	readonly write: (file: string, content: unknown) => Promise<void>;
}> {
	const dir = await mkdtemp(path.join(tmpdir(), 'tsc-bridge-diff-'));
	await mkdir(path.join(dir, 'src'));
	const write = (file: string, content: unknown) =>
		writeFile(
			path.join(dir, file),
			typeof content === 'string' ? content : JSON.stringify(content),
		);
	return { dir, write };
}

const tsconfig = (strict: boolean) => ({
	extends: './base.json',
	compilerOptions: { strict, target: 'ESNext', module: 'NodeNext', types: [], noEmit: true },
	include: ['src/**/*.ts'],
});

test('cached diagnostics match a fresh helper after every edit', { timeout }, async () => {
	const { dir, write } = await project();
	const bridge = createTscBridge({ cwd: dir });
	try {
		await write('base.json', { compilerOptions: { noUnusedLocals: false } });
		await write('tsconfig.json', tsconfig(false));
		await write('src/codes.ts', "export const code: string = 'a';\n");
		await write(
			'src/index.ts',
			"import { code } from './codes.js';\nexport const n: string = code;\n",
		);
		await write('src/loose.ts', 'export function g(x) { return x; }\n');
		await write('src/unused.ts', 'export function h() { const unused = 1; }\n');

		const steps: readonly {
			readonly name: string;
			readonly edit: () => Promise<void>;
			readonly expected: readonly Located[];
		}[] = [
			{ name: 'initial project', edit: async () => {}, expected: [] },
			{
				name: 'a dependency changes type',
				edit: () => write('src/codes.ts', 'export const code: number = 1;\n'),
				expected: [['index.ts', 2322]],
			},
			{
				name: 'the dependency is restored',
				edit: () => write('src/codes.ts', "export const code: string = 'b';\n"),
				expected: [],
			},
			{
				name: 'tsconfig.json turns strict on',
				edit: () => write('tsconfig.json', tsconfig(true)),
				expected: [['loose.ts', 7006]],
			},
			{
				name: 'the extended config turns noUnusedLocals on',
				edit: () => write('base.json', { compilerOptions: { noUnusedLocals: true } }),
				expected: [
					['loose.ts', 7006],
					['unused.ts', 6133],
				],
			},
			{
				name: 'a new file matches include',
				edit: () => write('src/extra.ts', 'export const e: string = 1;\n'),
				expected: [
					['extra.ts', 2322],
					['loose.ts', 7006],
					['unused.ts', 6133],
				],
			},
			{
				name: 'an imported file is deleted',
				edit: () => rm(path.join(dir, 'src/codes.ts')),
				expected: [
					['extra.ts', 2322],
					['index.ts', 2307],
					['loose.ts', 7006],
					['unused.ts', 6133],
				],
			},
			{
				name: 'the deleted file returns',
				edit: () => write('src/codes.ts', "export const code: string = 'c';\n"),
				expected: [
					['extra.ts', 2322],
					['loose.ts', 7006],
					['unused.ts', 6133],
				],
			},
		];

		for (const step of steps) {
			await step.edit();
			const cached = await bridge.checkProject('tsconfig.json');
			const fresh = checkProjectSync('tsconfig.json', { cwd: dir });
			assert.deepEqual(cached, fresh, `cached and fresh diverge after: ${step.name}`);
			assert.deepEqual(
				[...located(cached)].sort(),
				[...step.expected].sort(),
				`unexpected diagnostics after: ${step.name}`,
			);
		}
	} finally {
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('overrides match the same tsconfig written to disk', { timeout }, async () => {
	const { dir, write } = await project();
	const bridge = createTscBridge({ cwd: dir });
	try {
		await write('base.json', { compilerOptions: {} });
		await write('tsconfig.json', tsconfig(false));
		await write('src/codes.ts', "export const code: string = 'a';\n");
		await write('src/loose.ts', 'export function g(x) { return x; }\n');
		await write('src/alias.ts', "import { code } from 'alias';\nexport const x: number = code;\n");

		const cases: readonly ProjectOverrides[] = [
			{ files: ['src/loose.ts'] },
			{ compilerOptions: { strict: true } },
			{ files: ['src/loose.ts', 'src/alias.ts'], compilerOptions: { strict: true } },
			{ files: ['src/alias.ts'], compilerOptions: { paths: { alias: ['./src/codes.ts'] } } },
			{ files: [] },
		];

		for (const [index, overrides] of cases.entries()) {
			const name = `tsconfig.case${index}.json`;
			await write(name, {
				extends: './tsconfig.json',
				...(overrides.compilerOptions === undefined
					? {}
					: { compilerOptions: overrides.compilerOptions }),
				...(overrides.files === undefined ? {} : { files: overrides.files, include: [] }),
			});
			const overlaid = await bridge.checkProject('tsconfig.json', overrides);
			const onDisk = await bridge.checkProject(name);
			assert.deepEqual(
				overlaid.map(({ code, category, messageText, start, length, fileName }) => ({
					code,
					category,
					messageText,
					start,
					length,
					fileName: fileName?.endsWith('tsconfig.bridge.json') ? undefined : fileName,
				})),
				onDisk.map(({ code, category, messageText, start, length, fileName }) => ({
					code,
					category,
					messageText,
					start,
					length,
					fileName: fileName?.endsWith(name) ? undefined : fileName,
				})),
				`overrides diverge from ${name}: ${JSON.stringify(overrides)}`,
			);
			assert.deepEqual(checkProjectSync('tsconfig.json', { cwd: dir, ...overrides }), overlaid);
		}
		assert.deepEqual(located(await bridge.checkProject('tsconfig.json', cases[3])), [
			['alias.ts', 2322],
		]);
	} finally {
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test('interleaved project requests stay consistent in one helper', { timeout }, async () => {
	const { dir, write } = await project();
	const bridge = createTscBridge({ cwd: dir });
	try {
		await write('base.json', { compilerOptions: {} });
		await write('tsconfig.json', tsconfig(true));
		await write('src/codes.ts', "export type AErrorCode = 'a' | 'b';\n");
		await write('src/index.ts', "export type { AErrorCode } from './codes.js';\n");
		await write('src/loose.ts', 'export function g(x) { return x; }\n');
		const strict: Promise<readonly Diagnostic[]>[] = [];
		const loose: Promise<readonly Diagnostic[]>[] = [];
		const unions: Promise<readonly CodeUnion[]>[] = [];
		for (let i = 0; i < 4; i++) {
			strict.push(bridge.checkProject('tsconfig.json'));
			unions.push(bridge.exportedCodeUnions('tsconfig.json', ['src/index.ts']));
			loose.push(bridge.checkProject('tsconfig.json', { compilerOptions: { strict: false } }));
		}
		for (const result of await Promise.all(strict)) {
			assert.deepEqual(located(result), [['loose.ts', 7006]]);
		}
		for (const result of await Promise.all(loose)) {
			assert.deepEqual(result, []);
		}
		for (const result of await Promise.all(unions)) {
			assert.deepEqual(result, [{ name: 'AErrorCode', codes: ['a', 'b'] }]);
		}
	} finally {
		await bridge.close();
		await rm(dir, { recursive: true, force: true });
	}
});
