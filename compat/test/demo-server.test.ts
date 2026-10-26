import { expect, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const demoDirectory = path.join(projectRoot, 'examples/tsc-compat');
const serverPath = path.join(demoDirectory, 'server.js');

async function availablePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(0, '127.0.0.1', resolve);
	});
	const address = listener.address();
	if (address === null || typeof address === 'string') {
		listener.close();
		throw new Error('could not reserve a local port');
	}
	await new Promise<void>((resolve, reject) =>
		listener.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

async function abortUpload(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let connected = false;
		const socket = createConnection(port, '127.0.0.1', () => {
			connected = true;
			socket.write(
				'POST /parse HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx',
			);
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 25);
		});
		socket.on('error', (error) => (connected ? resolve() : reject(error)));
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error('timed out connecting to the demo server'));
		}, 2_000).unref();
		socket.once('close', () => clearTimeout(timeout));
	});
}

test('the demo server contains aborted uploads and completed-request failures', async () => {
	const nodePath = Bun.which('node');
	if (nodePath === null) throw new Error('Node.js is required for the demo server regression test');
	const port = await availablePort();
	const child = Bun.spawn([nodePath, serverPath], {
		cwd: demoDirectory,
		env: { ...process.env, PORT: String(port) },
		stdout: 'ignore',
		stderr: 'ignore',
	});
	try {
		let ready = false;
		for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
			try {
				ready = (await fetch(`http://127.0.0.1:${port}/`)).ok;
			} catch {
				await Bun.sleep(25);
			}
		}
		expect(ready).toBe(true);

		await abortUpload(port);
		await Bun.sleep(50);

		// This complete upload exceeds the recursive AST processing limits.
		const failed = await fetch(`http://127.0.0.1:${port}/parse`, {
			method: 'POST',
			body: `const value = ${'1 + '.repeat(10_000)}1;`,
			signal: AbortSignal.timeout(3_000),
		});
		expect(failed.status).toBe(500);
		expect(await failed.text()).toBe('Internal Server Error');

		const page = await fetch(`http://127.0.0.1:${port}/`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('AST explorer');

		const parsed = await fetch(`http://127.0.0.1:${port}/parse`, {
			method: 'POST',
			body: 'const value = 42;',
		});
		expect(parsed.status).toBe(200);
		const payload: { readonly tree: { readonly kind: string } } = await parsed.json();
		expect(payload.tree.kind).toBe('SourceFile');
	} finally {
		child.kill('SIGKILL');
		await child.exited;
	}
}, 10_000);
