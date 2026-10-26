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

export type CompilerResult<T> = (T & { readonly error?: undefined }) | { readonly error: string };

export interface Compiler {
	parse(
		fileName: string,
		text: Uint8Array,
		scriptKind: number,
		cwd: string,
	): CompilerResult<{
		readonly data: Uint8Array;
		readonly diagnostics: string;
	}>;
	toObject(
		fileName: string,
		text: Uint8Array,
		cwd: string,
	): CompilerResult<{
		readonly value: string;
		readonly diagnostics: string;
	}>;
	parseConfig(
		fileName: string,
		text: Uint8Array,
		basePath: string,
		configFileName: string,
		host: object,
	): CompilerResult<{ readonly value: string }>;
}

interface DecoderModule {
	readonly RemoteSourceFile: RemoteSourceFile;
}

interface Wtf8Module {
	readonly Wtf8Decoder: new () => TextDecoder;
	encodeWtf8(text: string): Uint8Array;
}

const require = createRequire(import.meta.url);

function startCompiler(): Compiler {
	if (Reflect.get(globalThis, 'fs') === undefined) Reflect.set(globalThis, 'fs', fs);
	require('../bin/wasm_exec.cjs');
	const Go: (new () => GoRuntime) | undefined = Reflect.get(globalThis, 'Go');
	if (Go === undefined) throw new Error('wasm_exec.cjs did not define Go');
	const go = new Go();
	const name = 'tscCompat';
	go.env = { ...go.env, TSC_COMPAT_GLOBAL: name };
	void go.run(initCompat(go.importObject));
	const compiler: Compiler | undefined = Reflect.get(globalThis, name);
	Reflect.deleteProperty(globalThis, name);
	if (compiler === undefined) throw new Error('The compat WebAssembly module did not start');
	return compiler;
}

export function unwrap<T>(value: CompilerResult<T>): T {
	if (value.error !== undefined) throw new Error(value.error);
	return value;
}

export const compiler: Compiler = startCompiler();
const root = path.dirname(require.resolve('typescript/package.json'));
const decoderModule: DecoderModule = await import(
	pathToFileURL(path.join(root, 'dist/api/node/node.js')).href
);
const wtf8Module: Wtf8Module = await import(
	pathToFileURL(path.join(root, 'dist/api/node/wtf8.js')).href
);
const { RemoteSourceFile } = decoderModule;
const decoder = new wtf8Module.Wtf8Decoder();

export const encodeWtf8: (text: string) => Uint8Array = wtf8Module.encodeWtf8;

export function decodeSourceFile(data: Uint8Array): SourceFile {
	return new RemoteSourceFile(data, decoder);
}
