import { existsSync } from 'node:fs';
import path from 'node:path';
import * as ts from '@kjanat/tsc-compat';
import type { CodeMapping, LanguagePlugin, VueVirtualCode } from '@vue/language-core';
import {
	createParsedCommandLine,
	createParsedCommandLineByJson,
	createVueLanguagePlugin,
	SourceMap,
	shouldReportDiagnostics,
} from '@vue/language-core';
import type { Handler } from '#rpc';
import { isRecord } from '@kjanat/tsc-protocol';

type VuePlugin = LanguagePlugin<string, VueVirtualCode>;

interface Generated {
	readonly text: string;
	readonly extension: string;
	readonly mappings: CodeMapping[];
}

interface VerifyDiagnostic {
	readonly start: number;
	readonly length: number;
	readonly code: number;
	readonly source?: string;
}

interface VerifyFile {
	readonly fileName: string;
	readonly content: string;
	readonly virtualText: string;
	readonly diagnostics: readonly VerifyDiagnostic[];
}

interface SourceSpan {
	readonly start: number;
	readonly length: number;
}

type Segment = readonly [
	virtualStart: number,
	virtualLength: number,
	originalStart: number,
	originalLength: number,
	kind: number,
];

type Directive = readonly [
	originalStart: number,
	originalLength: number,
	virtualStart: number,
	virtualEnd: number,
	policy: number,
];

const verbatim = 0;
const atom = 1;
const ignore = 0;

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isOffset(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isVerifyDiagnostic(value: unknown): value is VerifyDiagnostic {
	return (
		isRecord(value) &&
		isOffset(value.start) &&
		isOffset(value.length) &&
		isOffset(value.code) &&
		(value.source === undefined || isString(value.source))
	);
}

function isVerifyFile(value: unknown): value is VerifyFile {
	return (
		isRecord(value) &&
		isString(value.fileName) &&
		isString(value.content) &&
		isString(value.virtualText) &&
		Array.isArray(value.diagnostics) &&
		value.diagnostics.every(isVerifyDiagnostic)
	);
}

function isVerifyFiles(value: unknown): value is readonly VerifyFile[] {
	return Array.isArray(value) && value.every(isVerifyFile);
}

function read<T>(params: unknown, key: string, guard: (value: unknown) => value is T): T {
	const value = isRecord(params) ? params[key] : undefined;
	if (!guard(value)) throw new TypeError(`Invalid ${key}: ${JSON.stringify(value)}`);
	return value;
}

const plugins = new Map<string, VuePlugin>();

function pluginFor(configFileName: string): VuePlugin {
	const cached = plugins.get(configFileName);
	if (cached !== undefined) return cached;
	const { vueOptions } = existsSync(configFileName)
		? createParsedCommandLine(ts, ts.sys, configFileName)
		: createParsedCommandLineByJson(ts, ts.sys, path.dirname(configFileName), {});
	const plugin = createVueLanguagePlugin<string>(ts, {}, vueOptions, (id) => id);
	plugins.set(configFileName, plugin);
	return plugin;
}

const context = { getAssociatedScript: () => undefined };

function generate(plugin: VuePlugin, fileName: string, content: string): Generated {
	const languageId = plugin.getLanguageId(fileName);
	if (languageId === undefined) throw new Error(`${fileName} is not a Vue file`);
	const root = plugin.createVirtualCode?.(
		fileName,
		languageId,
		ts.ScriptSnapshot.fromString(content),
		context,
	);
	if (root === undefined) throw new Error(`${fileName} produced no virtual code`);
	try {
		const service = plugin.typescript?.getServiceScript(root);
		if (service === undefined) throw new Error(`${fileName} produced no TypeScript`);
		const { snapshot, mappings } = service.code;
		return {
			text: snapshot.getText(0, snapshot.getLength()),
			extension: service.extension,
			mappings,
		};
	} finally {
		plugin.disposeVirtualCode?.(fileName, root);
	}
}

function segments(mappings: readonly CodeMapping[], text: string, original: string): Segment[] {
	const candidates: Segment[] = [];
	for (const mapping of mappings) {
		const virtualLengths = mapping.generatedLengths ?? mapping.lengths;
		mapping.generatedOffsets.forEach((virtualStart, i) => {
			const virtualLength = virtualLengths[i] ?? 0;
			const originalStart = mapping.sourceOffsets[i] ?? 0;
			const originalLength = mapping.lengths[i] ?? 0;
			if (virtualLength === 0) return;
			const same =
				virtualLength === originalLength &&
				text.slice(virtualStart, virtualStart + virtualLength) ===
					original.slice(originalStart, originalStart + originalLength);
			candidates.push([
				virtualStart,
				virtualLength,
				originalStart,
				originalLength,
				same ? verbatim : atom,
			]);
		});
	}
	candidates.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	const kept: Segment[] = [];
	for (const candidate of candidates) {
		const [start, length] = candidate;
		let low = 0;
		let high = kept.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((kept[middle]?.[0] ?? Number.POSITIVE_INFINITY) < start) low = middle + 1;
			else high = middle;
		}
		const before = kept[low - 1];
		const after = kept[low];
		if (before !== undefined && before[0] + before[1] > start) continue;
		if (after !== undefined && after[0] < start + length) continue;
		kept.splice(low, 0, candidate);
	}
	return kept;
}

function gaps(mappings: readonly CodeMapping[], length: number): Directive[] {
	const covered: (readonly [number, number])[] = [];
	for (const mapping of mappings) {
		if (!mapping.data.verification) continue;
		const virtualLengths = mapping.generatedLengths ?? mapping.lengths;
		mapping.generatedOffsets.forEach((start, i) => {
			covered.push([start, start + (virtualLengths[i] ?? 0) + 1]);
		});
	}
	covered.sort((a, b) => a[0] - b[0]);
	const result: Directive[] = [];
	let cursor = 0;
	for (const [start, end] of covered) {
		if (start > cursor) result.push([-1, 0, cursor, start, ignore]);
		cursor = Math.max(cursor, end);
	}
	if (cursor < length) result.push([-1, 0, cursor, length, ignore]);
	return result;
}

function transform(projects: ReadonlyMap<string, string>, params: unknown) {
	const handle = read(params, 'projectHandle', isString);
	const configFileName = projects.get(handle);
	if (configFileName === undefined) throw new Error(`Unknown project handle ${handle}`);
	const content = read(params, 'content', isString);
	const generated = generate(
		pluginFor(configFileName),
		read(params, 'fileName', isString),
		content,
	);
	return {
		text: generated.text,
		extension: generated.extension,
		mappings: segments(generated.mappings, generated.text, content),
		diagnosticDirectives: {
			unusedExpectDirectiveDiagnostics: [],
			directives: gaps(generated.mappings, generated.text.length),
		},
	};
}

function verify(params: unknown): (SourceSpan | null)[][] {
	const plugin = pluginFor(read(params, 'configFileName', isString));
	return read(params, 'files', isVerifyFiles).map((file) => {
		const generated = generate(plugin, file.fileName, file.content);
		if (generated.text !== file.virtualText) {
			throw new Error(`${file.fileName}: generated code differs from the compiled virtual file`);
		}
		const map = new SourceMap(generated.mappings);
		return file.diagnostics.map((diagnostic) => {
			const filter = (data: CodeMapping['data']): boolean =>
				shouldReportDiagnostics(data, String(diagnostic.source), String(diagnostic.code));
			const end = diagnostic.start + diagnostic.length;
			for (const [start, mappedEnd] of map.toSourceRange(diagnostic.start, end, true, filter)) {
				return { start, length: mappedEnd - start };
			}
			return null;
		});
	});
}

export function createHandler(): Handler {
	const projects = new Map<string, string>();
	return (method, params) => {
		switch (method) {
			case 'initialize':
				return { positionEncoding: 'utf-16', diagnosticSource: 'vue' };
			case 'openProject':
				projects.set(
					read(params, 'projectHandle', isString),
					read(params, 'configFileName', isString),
				);
				return {};
			case 'closeProject':
				projects.delete(read(params, 'projectHandle', isString));
				return null;
			case 'transform':
				return transform(projects, params);
			case 'verify':
				return verify(params);
			default:
				throw new Error(`Unknown method: ${method}`);
		}
	};
}
