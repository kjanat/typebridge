#!/usr/bin/env bun
import { join, relative } from 'node:path';
import { $ } from 'bun';

const cwd = import.meta.dirname;
const bin = join(cwd, 'bin');
const wasm = join(bin, 'compat.wasm');

$.cwd(cwd).env({ ...process.env, GOWORK: 'off', GOOS: 'js', GOARCH: 'wasm' });

await $`go build -trimpath '-ldflags=-s -w' -o ${wasm} .`;
const goroot = (await $`go env GOROOT`.text()).trim();
await Bun.write(join(bin, 'wasm_exec.cjs'), Bun.file(join(goroot, 'lib/wasm/wasm_exec.js')));

console.log(`Built ${relative(process.cwd(), wasm)} and its matching Go JS runtime.`);
