#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createSourceFile, forEachChild, getTokenPosOfNode, SyntaxKind } from '@kjanat/tsc-compat';

const page = readFileSync(new URL('./index.html', import.meta.url));
const port = Number(process.env.PORT ?? 3000);

const kindNames = new Map();
for (const [name, kind] of Object.entries(SyntaxKind)) {
	if (typeof kind === 'number' && !kindNames.has(kind)) kindNames.set(kind, name);
}

function describe(node, file) {
	const children = [];
	forEachChild(node, (child) => {
		children.push(describe(child, file));
	});
	return {
		kind: kindNames.get(node.kind) ?? String(node.kind),
		start: getTokenPosOfNode(node, file),
		end: node.end,
		children,
	};
}

function parse(fileName, text) {
	const started = performance.now();
	const file = createSourceFile(fileName, text, 99);
	const tree = describe(file, file);
	return {
		milliseconds: performance.now() - started,
		tree,
		diagnostics: file.parseDiagnostics.map(({ code, start, length, messageText }) => ({
			code,
			start,
			length,
			message: messageText,
		})),
	};
}

async function body(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

createServer((request, response) => {
	void (async () => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (request.method === 'POST' && url.pathname === '/parse') {
			const fileName = url.searchParams.get('file') === 'tsx' ? 'example.tsx' : 'example.ts';
			const result = parse(fileName, await body(request));
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(result));
			return;
		}
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end(page);
	})().catch(() => {
		if (response.destroyed || response.writableEnded) return;
		if (response.headersSent) {
			response.destroy();
			return;
		}
		response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
		response.end('Internal Server Error');
	});
}).listen(port, () => {
	console.log(`http://localhost:${port}`);
});
