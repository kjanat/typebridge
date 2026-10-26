import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { Diagnostic } from '@kjanat/tsc-bridge';
import { checkProjectSync, formatDiagnostic } from '@kjanat/tsc-bridge';

const timeout = 60_000;

const fixture = path.join(import.meta.dirname, 'fixture');
const config = path.join(fixture, 'tsconfig.json');

function formatted(diagnostics: readonly Diagnostic[]): string[] {
	return diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, fixture));
}

const vueTsc = [
	"Broken.vue(6,7): error TS2322: Type 'number' is not assignable to type 'string'.",
	"Broken.vue(7,7): error TS6133: 'unused' is declared but its value is never read.",
	"Broken.vue(14,11): error TS2322: Type 'string' is not assignable to type 'number'.",
	[
		"Broken.vue(14,24): error TS2322: Type '(value: string) => void' is not assignable to type '(value: number) => any'.",
		"  Types of parameters 'value' and 'value' are incompatible.",
		"    Type 'number' is not assignable to type 'string'.",
	].join('\n'),
	"Broken.vue(16,24): error TS2339: Property 'nope' does not exist on type 'number'.",
	"Broken.vue(21,3): error TS2578: Unused '@ts-expect-error' directive.",
	"main.ts(4,14): error TS2322: Type 'DefineComponent<{}, {}, {}, {}, {}, ComponentOptionsMixin, ComponentOptionsMixin, {}, string, PublicProps, ToResolvedProps<{}, {}>, ... 8 more ..., any>' is not assignable to type 'number'.",
];

test('reports what vue-tsc 3.3.11 reports on TypeScript 6', { timeout }, () => {
	assert.deepEqual(formatted(checkProjectSync(config, { runExternalCode: true })), vueTsc);
});

test('reports the same through the WASM bridge without starting a process', { timeout }, () => {
	const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'wasm.ts')], {
		encoding: 'utf8',
		env: { ...process.env, PATH: import.meta.dirname },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), vueTsc);
});

test('runs no mapper without runExternalCode', { timeout }, () => {
	assert.deepEqual(formatted(checkProjectSync(config)), [
		"main.ts(1,20): error TS2307: Cannot find module './Broken.vue' or its corresponding type declarations.",
		"main.ts(2,19): error TS2307: Cannot find module './Child.vue' or its corresponding type declarations.",
		"tsconfig.json(14,2): error TS18068: Content mappers require the '--runExternalCode' command line flag to be enabled.",
	]);
});
