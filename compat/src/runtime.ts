import { isRecord } from '@kjanat/tsc-protocol';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SourceFile } from 'typescript/ast';
import initCompat from '../bin/compat.wasm?init&sync';

interface GoRuntime {
	env: Record<string, string>;
	readonly importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
}

interface TextDecoder {
	decode(input?: Uint8Array): string;
}

type RemoteSourceFile = new (data: Uint8Array, decoder: TextDecoder) => SourceFile;

export interface Compiler {
	parse(fileName: string, text: Uint8Array, scriptKind: number, cwd: string): unknown;
	toObject(fileName: string, text: Uint8Array, cwd: string): unknown;
	parseConfig(
		fileName: string,
		text: Uint8Array,
		basePath: string,
		configFileName: string,
		host: object,
	): unknown;
}

function isGoConstructor(value: unknown): value is new () => GoRuntime {
	return typeof value === 'function';
}

function isCompiler(value: unknown): value is Compiler {
	return (
		isRecord(value) &&
		typeof value.parse === 'function' &&
		typeof value.toObject === 'function' &&
		typeof value.parseConfig === 'function'
	);
}

function isDecoderModule(value: unknown): value is { readonly RemoteSourceFile: RemoteSourceFile } {
	return isRecord(value) && typeof value.RemoteSourceFile === 'function';
}

interface Wtf8Module {
	readonly Wtf8Decoder: new () => TextDecoder;
	encodeWtf8(text: string): Uint8Array;
}

function isWtf8Module(value: unknown): value is Wtf8Module {
	return (
		isRecord(value) &&
		typeof value.Wtf8Decoder === 'function' &&
		typeof value.encodeWtf8 === 'function'
	);
}

const require = createRequire(import.meta.url);

function startCompiler(): Compiler {
	if (Reflect.get(globalThis, 'fs') === undefined) Reflect.set(globalThis, 'fs', fs);
	require('../bin/wasm_exec.cjs');
	const Go: unknown = Reflect.get(globalThis, 'Go');
	if (!isGoConstructor(Go)) throw new Error('wasm_exec.cjs did not define Go');
	const go = new Go();
	const name = 'tscCompat';
	go.env = { ...go.env, TSC_COMPAT_GLOBAL: name };
	void go.run(initCompat(go.importObject));
	const compiler: unknown = Reflect.get(globalThis, name);
	Reflect.deleteProperty(globalThis, name);
	if (!isCompiler(compiler)) throw new Error('The compat WebAssembly module did not start');
	return compiler;
}

async function importDist(file: string): Promise<unknown> {
	const root = path.dirname(require.resolve('typescript/package.json'));
	return import(pathToFileURL(path.join(root, 'dist', file)).href);
}

export function unwrap(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error('The compat WebAssembly module returned no result');
	if (typeof value.error === 'string') throw new Error(value.error);
	return value;
}

export const compiler: Compiler = startCompiler();

const decoderModule = await importDist('api/node/node.js');
const wtf8Module = await importDist('api/node/wtf8.js');
if (!isDecoderModule(decoderModule) || !isWtf8Module(wtf8Module)) {
	throw new Error('typescript does not ship the source file decoder this package expects');
}
const { RemoteSourceFile } = decoderModule;
const decoder = new wtf8Module.Wtf8Decoder();

export const encodeWtf8: (text: string) => Uint8Array = wtf8Module.encodeWtf8;

export function decodeSourceFile(data: Uint8Array): SourceFile {
	return new RemoteSourceFile(data, decoder);
}
