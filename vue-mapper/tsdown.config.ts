import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: { index: 'src/index.ts', server: 'src/server.ts' },
	exports: { exclude: ['server'], bin: './src/server.ts' },
});
