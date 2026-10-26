#!/usr/bin/env bun
import { join, relative } from 'node:path';
import { $ } from 'bun';

const cwd = import.meta.dirname;
const bin = join(cwd, 'bin');
const wasm = join(bin, 'tsc-bridge.wasm');

$.cwd(cwd).env({
	...process.env,
	GOWORK: 'off',
	GOOS: 'js',
	GOARCH: 'wasm',
	GOMAXPROCS: process.env.GOMAXPROCS ?? '2',
	GOMEMLIMIT: process.env.GOMEMLIMIT ?? '1GiB',
});

await $`go build -p 2 -trimpath '-ldflags=-s -w' -o ${wasm} .`;
const goroot = (await $`go env GOROOT`.text()).trim();
await Bun.write(join(bin, 'wasm_exec.js'), Bun.file(join(goroot, 'lib/wasm/wasm_exec.js')));

console.log(`Built ${relative(process.cwd(), wasm)} and its matching Go JS runtime.`);
