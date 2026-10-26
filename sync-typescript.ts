#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** Synchronize the native compiler with the exact TypeScript npm release. */
import { Schema } from 'effect';
import manifest from '#pkg' with { type: 'json' };
import compat from './compat/package.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const compilerModule = 'github.com/microsoft/TypeScript/tsc';
const modules = ['protocol', 'compat', 'bridge', 'wasm'];

export function compilerVersion(catalog: unknown, compat: unknown): string {
	if (
		typeof catalog !== 'string' ||
		!/^npm:typescript@7\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(catalog)
	) {
		throw new Error('The ts7 catalog must specify an exact TypeScript 7 version');
	}
	const version = catalog.slice('npm:typescript@'.length);
	if (compat !== version) throw new Error('The ts7 catalog and compat compiler versions differ');
	return version;
}

export function compilerCommit(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
		throw new Error('The TypeScript npm release must identify its full gitHead');
	}
	return value;
}

function run(command: string, args: readonly string[], cwd = root): string {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GOWORK: 'off' },
		stdio: ['ignore', 'pipe', 'inherit'],
		timeout: 120_000,
	}).trim();
}

async function syncCompiler() {
	const version = compilerVersion(
		manifest.catalogs?.ts7?.typescript,
		compat.dependencies?.typescript,
	);
	const commit = compilerCommit(
		Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(
			run('bun', ['pm', 'view', `typescript@${version}`, 'gitHead', '--json']),
		),
	);
	const resolved = Schema.decodeUnknownSync(
		Schema.fromJsonString(Schema.Struct({ Version: Schema.String })),
	)(run('go', ['list', '-m', '-json', `${compilerModule}@${commit}`]));
	if (
		!/^v0\.0\.0-\d{14}-[0-9a-f]{12}$/.test(resolved.Version) ||
		!resolved.Version.endsWith(commit.slice(0, 12))
	) {
		throw new Error('Go module resolution does not match the npm compiler commit');
	}
	const requirement = `${compilerModule} ${resolved.Version}`;
	const directories = modules.map((name) => path.join(root, name));
	const current = await Promise.all(
		directories.map((dir) => readFile(path.join(dir, 'go.mod'), 'utf8')),
	);
	if (
		current.every((text) =>
			text.split('\n').some(
				(line) =>
					line
						.trim()
						.replace(/^require /, '')
						.replace(/ \/\/ indirect$/, '') === requirement,
			),
		)
	) {
		console.log(`TypeScript ${version}: all four Go modules already match ${commit.slice(0, 12)}`);
		return;
	}
	// Update every local module before tidy follows the protocol replacements.
	for (const dir of directories)
		run('go', ['mod', 'edit', `-require=${compilerModule}@${resolved.Version}`], dir);
	for (const dir of directories) run('go', ['mod', 'tidy'], dir);
	console.log(`TypeScript ${version}: synchronized all four Go modules to ${resolved.Version}`);
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	await syncCompiler();
}
