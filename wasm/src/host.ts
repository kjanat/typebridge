import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MapperConnection as Connection, MapperModule } from '@kjanat/tsc-protocol';
import { Schema } from 'effect';

interface HostProcess {
	write(chunk: Uint8Array): void;
	close(): void;
}

type Spawn = (
	command: readonly string[],
	cwd: string,
	onStdout: (chunk: Uint8Array) => void,
	onStderr: (chunk: Uint8Array) => void,
	onClose: (code: number | null, error?: string) => void,
) => HostProcess;

export interface Host {
	readonly spawn: Spawn;
	stop(): void;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const decodeManifest = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			tscBridge: Schema.optional(Schema.Struct({ module: Schema.optional(Schema.String) })),
		}),
	),
);

function moduleOf(directory: string): string | undefined {
	const manifest = decodeManifest(readFileSync(path.join(directory, 'package.json'), 'utf8'));
	const entry = manifest.tscBridge?.module;
	return entry === undefined ? undefined : path.resolve(directory, entry);
}

export function createHost(): Host {
	const children = new Set<ChildProcess>();
	let stopped = false;

	function inProcess(
		entry: string,
		onStdout: (chunk: Uint8Array) => void,
		onClose: (code: number | null, error?: string) => void,
	): HostProcess {
		const queued: Uint8Array[] = [];
		let connection: Connection | undefined;
		let closed = false;

		function finish(code: number | null, error?: string): void {
			if (closed) return;
			closed = true;
			if (!stopped) onClose(code, error);
		}

		function feed(target: Connection, chunk: Uint8Array): void {
			try {
				target.receive(chunk);
			} catch (error) {
				finish(null, messageOf(error));
			}
		}

		import(pathToFileURL(entry).href)
			.then((module: MapperModule) => {
				const { connect } = module;
				if (connect === undefined) throw new Error(`${entry} does not export connect`);
				const created = connect((chunk: Uint8Array) => {
					if (!closed && !stopped) onStdout(chunk);
				});
				connection = created;
				for (const chunk of queued.splice(0)) feed(created, chunk);
			})
			.catch((error: unknown) => finish(null, messageOf(error)));

		return {
			write(chunk) {
				if (closed) return;
				if (connection === undefined) queued.push(chunk.slice());
				else feed(connection, chunk);
			},
			close() {
				finish(0);
			},
		};
	}

	function childProcess(
		command: readonly string[],
		cwd: string,
		onStdout: (chunk: Uint8Array) => void,
		onStderr: (chunk: Uint8Array) => void,
		onClose: (code: number | null, error?: string) => void,
	): HostProcess {
		const [file = '', ...args] = command;
		const child = spawn(file, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		children.add(child);
		let failure: string | undefined;
		child.stdout.on('data', (chunk: Buffer) => {
			if (!stopped) onStdout(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			if (!stopped) onStderr(chunk);
		});
		child.stdin.on('error', () => {});
		child.on('error', (error) => {
			failure = error.message;
		});
		child.on('close', (code) => {
			children.delete(child);
			if (!stopped) onClose(code, failure);
		});
		return {
			write(chunk) {
				child.stdin.write(chunk);
			},
			close() {
				child.stdin.end();
				child.kill();
			},
		};
	}

	return {
		spawn(command, cwd, onStdout, onStderr, onClose) {
			const entry = moduleOf(cwd);
			return entry === undefined
				? childProcess(command, cwd, onStdout, onStderr, onClose)
				: inProcess(entry, onStdout, onClose);
		},
		stop() {
			stopped = true;
			for (const child of children) child.kill();
		},
	};
}
