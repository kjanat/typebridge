import path from 'node:path';
import { formatDiagnostic } from '@kjanat/tsc-bridge';
import { createWasmBridge } from '@kjanat/tsc-wasm';

const fixture = path.join(import.meta.dirname, 'fixture');
const compiler = await createWasmBridge();
try {
	const diagnostics = await compiler.checkProject(path.join(fixture, 'tsconfig.json'), {
		runExternalCode: true,
	});
	console.log(
		JSON.stringify(diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, fixture))),
	);
} finally {
	await compiler.close();
}
