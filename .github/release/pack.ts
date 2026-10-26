import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Schema } from 'effect';
import project from '#pkg' with { type: 'json' };

const workspace = process.argv[2] ?? process.env.PACKAGE;
assert(
	workspace !== undefined && project.workspaces.includes(workspace),
	'Argument or PACKAGE must name a workspace',
);
const manifest = Schema.decodeUnknownSync(
	Schema.Struct({ name: Schema.String, version: Schema.String }),
)(await Bun.file(resolve(workspace, 'package.json')).json());
const tag = process.env.RELEASE_TAG;
if (tag) assert.equal(`v${manifest.version}`, tag, `${manifest.name} does not match release tag`);

const destination = resolve('artifacts');
await mkdir(destination, { recursive: true });
const archive = resolve(destination, `${workspace}.tgz`);
execFileSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', archive], {
	cwd: resolve(workspace),
	stdio: 'inherit',
});
const digest = createHash('sha256')
	.update(await readFile(archive))
	.digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${workspace}.tgz\n`);
console.log(`Packed ${manifest.name}@${manifest.version}: ${archive}`);
