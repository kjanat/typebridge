import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import project from '#pkg' with { type: 'json' };

const sha = process.argv[2] ?? process.env.PREVIEW_SHA;
assert(sha && /^[0-9a-f]{40}$/.test(sha), 'Choose the exact preview commit SHA');

await Promise.all(
	project.workspaces.map(async (workspace) => {
		const url = `https://pkg.pr.new/@kjanat/tsc-${workspace}@${sha}`;
		const response = await fetch(url);
		assert(response.ok, `${url}: HTTP ${response.status}`);
		const archive = new Uint8Array(await response.arrayBuffer());
		const expected = (await readFile(`artifacts/${workspace}.tgz.sha256`, 'utf8')).split(/\s+/)[0];
		const actual = createHash('sha256').update(archive).digest('hex');
		assert.equal(actual, expected, `${workspace}: preview differs from its build artifact`);
		await writeFile(`artifacts/${workspace}.tgz`, archive);
		console.log(`Verified preview tarball: ${url}`);
	}),
);
