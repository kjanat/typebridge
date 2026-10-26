import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { wasm } from 'rolldown-plugin-wasm';
import { defineConfig } from 'tsdown';

export default defineConfig({
	workspace: { include: ['protocol', 'bridge', 'compat', 'wasm', 'vue-mapper'] },
	dts: true,
	plugins: [wasm()],
	exports: {
		enabled: true,
		customExports(exports, { pkg }) {
			const root = typeof pkg.packageJsonPath === 'string' ? dirname(pkg.packageJsonPath) : '.';
			for (const [key, value] of Object.entries(exports)) {
				const conditions = typeof value === 'string' ? { default: value } : value;
				const path = conditions?.default;
				if (typeof path !== 'string') continue;
				const types = path.replace(/\.([mc]?)js$/, '.d.$1ts');
				if (types !== path && existsSync(join(root, types)))
					exports[key] = { types, ...conditions };
			}
			return exports;
		},
	},
});
