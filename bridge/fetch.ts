#!/usr/bin/env bun
import { chmod } from 'node:fs/promises';
import { exit } from 'node:process';
import { flag, isCLIError, readFlags } from '@kjanat/dreamcli';

const { sha, branch } = await readFlags({
	sha: flag.string().env('GITHUB_SHA').describe('Commit to fetch the helper from'),
	branch: flag.string().env('GITHUB_REF_NAME').describe('Branch to try when the commit has none'),
}).catch((error: unknown) => {
	if (!isCLIError(error)) throw error;
	console.error(error.message);
	return exit(error.exitCode);
});

const entry = 'package/bin/tsc-bridge';
const binary = new URL('./bin/tsc-bridge', import.meta.url);
const refs = new Set(
	[sha, branch, 'master'].filter((ref): ref is string => ref !== undefined && ref !== ''),
);

async function download(ref: string): Promise<Uint8Array | undefined> {
	const url = `https://pkg.pr.new/kjanat/typebridge/@kjanat/tsc-bridge@${ref}`;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (response.ok) return await response.bytes();
			console.error(`${url}: ${response.status}`);
			if (response.status < 500) return undefined;
		} catch (error) {
			console.error(`${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

for (const ref of refs) {
	const tarball = await download(ref);
	if (tarball === undefined) continue;
	const file = (await new Bun.Archive(tarball).files(entry)).get(entry);
	const bridge = `tsc-bridge@${ref}`;
	if (file === undefined) {
		console.error(`${bridge}: no ${entry}`);
		continue;
	}
	await Bun.write(binary, file);
	await chmod(binary, 0o755);
	console.log(`${bridge}`);
	exit(0);
}
exit(1);
