import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import project from '#pkg' with { type: 'json' };

const runtime = process.argv[2];
assert(runtime === 'node' || runtime === 'bun', 'Choose node or bun');
await mkdir('.cache', { recursive: true });
const consumer = await mkdtemp(resolve('.cache/package-consumer-'));
const packages = Object.fromEntries(
	project.workspaces.map((workspace) => [
		`@kjanat/tsc-${workspace}`,
		`file:${resolve('artifacts', `${workspace}.tgz`)}`,
	]),
);
await writeFile(
	resolve(consumer, 'package.json'),
	JSON.stringify({
		private: true,
		type: 'module',
		dependencies: { ...packages, effect: project.catalog.effect, vue: project.catalog.vue },
		overrides: packages,
	}),
);
await Promise.all([
	cp('wasm/test/fixture', resolve(consumer, 'unions'), { recursive: true }),
	cp('vue-mapper/test/fixture', resolve(consumer, 'vue'), { recursive: true }),
	cp(fileURLToPath(new URL('./smoke.mjs', import.meta.url)), resolve(consumer, 'smoke.mjs')),
]);
execFileSync('bun', ['install', '--ignore-scripts'], { cwd: consumer, stdio: 'inherit' });
execFileSync(runtime, ['smoke.mjs'], { cwd: consumer, stdio: 'inherit' });
