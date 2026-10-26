import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkProjectSync, createTscBridge, makeTscBridge } from '@kjanat/tsc-bridge';
import { createSourceFile } from '@kjanat/tsc-compat';
import { createWasmBridge, makeWasmBridge } from '@kjanat/tsc-wasm';
import { Effect } from 'effect';

for (const name of ['protocol', 'bridge', 'compat', 'wasm', 'vue-mapper']) {
	assert.ok(
		import.meta
			.resolve(`@kjanat/tsc-${name}`)
			.startsWith(`${import.meta.url.slice(0, import.meta.url.lastIndexOf('/'))}/node_modules/`),
	);
}
const native = createTscBridge();
const wasm = await createWasmBridge();
try {
	const input = 'export const answer: number = 42;';
	assert.deepEqual(await wasm.transpile(input), await native.transpile(input));
	assert.equal(createSourceFile('input.ts', input).parseDiagnostics.length, 0);
	const config = fileURLToPath(new URL('./unions/tsconfig.json', import.meta.url));
	const expected = [
		{ name: 'ParseErrorCode', codes: ['malformed', 'unsupported'] },
		{ name: 'VerifyReasonCode', codes: ['expired', 'untrusted'] },
	];
	assert.deepEqual(await native.exportedCodeUnions(config, ['index.ts']), expected);
	assert.deepEqual(await wasm.exportedCodeUnions(config, ['index.ts']), expected);
	const vue = fileURLToPath(new URL('./vue/tsconfig.json', import.meta.url));
	const diagnostics = checkProjectSync(vue, { runExternalCode: true });
	if (diagnostics.length !== 7) console.log(diagnostics);
	assert.equal(diagnostics.length, 7);
	assert.ok(diagnostics.every(({ code }) => [2322, 6133, 2339, 2578].includes(code)));
	console.log(
		'Installed package archives: native, WASM, compatibility API, protocol and Vue mapper verified.',
	);
} finally {
	await wasm.close();
	await native.close();
}

const nativeResult = await Effect.runPromise(
	Effect.scoped(
		makeTscBridge().pipe(
			Effect.flatMap((compiler) => compiler.transpile('export const answer: number = 42;')),
		),
	),
);
const wasmResult = await Effect.runPromise(
	Effect.scoped(
		makeWasmBridge().pipe(
			Effect.flatMap((compiler) => compiler.transpile('export const answer: number = 42;')),
		),
	),
);
assert.deepEqual(wasmResult, nativeResult);
console.log('Effect scopes from installed archives: native and WASM verified.');
