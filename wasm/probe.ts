#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createTscBridge } from '@kjanat/tsc-bridge';
import type { TscBridge } from '#wasm';
import { createWasmBridge } from '#wasm';

const bytes = fs.readFileSync(new URL('./bin/tsc-bridge.wasm', import.meta.url));
const started = performance.now();
const wasm = await createWasmBridge();
const startupMs = performance.now() - started;
console.log(
	JSON.stringify({ wasmBytes: bytes.length, gzipBytes: gzipSync(bytes).length, startupMs }),
);

async function timed<T>(method: string, work: () => Promise<T>): Promise<T> {
	const start = performance.now();
	const result = await work();
	console.log(JSON.stringify({ method, ms: performance.now() - start }));
	return result;
}

const configPath = fileURLToPath(new URL('./test/fixture/tsconfig.json', import.meta.url));
const project = fileURLToPath(new URL('./bin/probe-project/', import.meta.url));
const native = createTscBridge();
try {
	const result = await timed('transpile', () =>
		wasm.transpile('export const answer: number = 42;'),
	);
	assert.deepEqual(result.diagnostics, []);
	const emitted: Record<string, unknown> = await import(
		`data:text/javascript,${encodeURIComponent(result.outputText)}`
	);
	assert.equal(emitted.answer, 42);
	const bad = await timed('transpile', () => wasm.transpile('export const answer: = 42;'));
	assert.ok(bad.diagnostics.some((d) => d.category === 1));
	assert.deepEqual(await timed('checkProject', () => wasm.checkProject(configPath)), []);
	const unions = await timed('exportedCodeUnions', () =>
		wasm.exportedCodeUnions(configPath, ['index.ts']),
	);
	assert.deepEqual(unions, [
		{ name: 'ParseErrorCode', codes: ['malformed', 'unsupported'] },
		{ name: 'VerifyReasonCode', codes: ['expired', 'untrusted'] },
	]);
	assert.deepEqual(unions, await native.exportedCodeUnions(configPath, ['index.ts']));

	fs.rmSync(project, { recursive: true, force: true });
	fs.mkdirSync(project, { recursive: true });
	fs.writeFileSync(
		`${project}tsconfig.json`,
		JSON.stringify({
			compilerOptions: { strict: true, target: 'ESNext', module: 'NodeNext', types: [] },
			include: ['*.ts'],
		}),
	);
	fs.writeFileSync(
		`${project}index.ts`,
		'export const f: (x: string) => void = (x: number) => {};\n',
	);
	fs.writeFileSync(`${project}loose.ts`, 'export function g(x) { return x; }\n');
	const probeConfig = `${project}tsconfig.json`;
	assert.ok(
		(await native.checkProject(probeConfig)).length > 0,
		'probe project must report diagnostics',
	);
	const loose = { files: ['loose.ts'], compilerOptions: { strict: false } };
	const batch: readonly ((bridge: TscBridge) => Promise<unknown>)[] = [
		(bridge) => bridge.transpile('export const answer: number = 42;'),
		(bridge) => bridge.checkProject(configPath),
		(bridge) => bridge.checkProject(probeConfig),
		(bridge) => bridge.exportedCodeUnions(configPath, ['index.ts']),
		(bridge) => bridge.transpile('export const answer: = 42;'),
		(bridge) => bridge.checkProject(probeConfig, loose),
	];
	const requests = [...batch, ...batch];
	const second = await createWasmBridge();
	try {
		const concurrent = await Promise.all(
			requests.map((request, index) => request(index % 2 === 0 ? wasm : second)),
		);
		for (const [index, request] of requests.entries()) {
			assert.deepEqual(concurrent[index], await request(native));
		}
	} finally {
		await second.close();
	}
	console.log(
		JSON.stringify({ concurrentRequests: requests.length, instances: 2, matchesNative: true }),
	);

	const inFlight = wasm.checkProject(probeConfig);
	const closing = wasm.close();
	assert.ok((await inFlight).length > 0, 'close must let in-flight requests finish');
	await closing;
	await assert.rejects(wasm.transpile(''), /closed/);
	console.log(
		JSON.stringify({
			verified: true,
			unionCount: unions.length,
			codeCount: unions.reduce((n, u) => n + u.codes.length, 0),
		}),
	);
} finally {
	await wasm.close();
	await native.close();
	fs.rmSync(project, { recursive: true, force: true });
}
