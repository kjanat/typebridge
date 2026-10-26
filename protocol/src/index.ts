export {
	decodeMapperMessage,
	encodeMapperResponse,
	MapperRequestSchema,
	MapperResultSchema,
	MapperResponseSchema,
	MapperTransformParamsSchema,
	MapperVerifyParamsSchema,
} from './mapper.ts';
export type {
	MapperConnection,
	MapperModule,
	MapperRequest,
	MapperResult,
	MapperSegment,
	MapperSourceSpan,
	MapperResponse,
	MapperTransformParams,
	MapperVerifyParams,
} from './mapper.ts';

import { Effect, Schema } from 'effect';

const DiagnosticBase = Schema.Struct({
	code: Schema.Int,
	category: Schema.Int,
	message: Schema.String,
	messageText: Schema.String,
	fileName: Schema.optional(Schema.String),
	start: Schema.Int,
	length: Schema.Int,
});

type DiagnosticFields = typeof DiagnosticBase.Type;
export interface Diagnostic extends DiagnosticFields {
	readonly children?: readonly Diagnostic[];
}

export const DiagnosticSchema: Schema.Codec<Diagnostic> = Schema.Struct({
	...DiagnosticBase.fields,
	children: Schema.optional(Schema.Array(Schema.suspend(() => DiagnosticSchema))),
});

export const TranspileResultSchema = Schema.Struct({
	outputText: Schema.String,
	diagnostics: Schema.Array(DiagnosticSchema),
});
export type TranspileResult = typeof TranspileResultSchema.Type;

export const CodeUnionSchema = Schema.Struct({
	name: Schema.String,
	codes: Schema.Array(Schema.String),
});
export type CodeUnion = typeof CodeUnionSchema.Type;

export const ProjectOverridesSchema = Schema.Struct({
	files: Schema.optional(Schema.Array(Schema.String)),
	compilerOptions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
	runExternalCode: Schema.optional(Schema.Boolean),
});
export type ProjectOverrides = typeof ProjectOverridesSchema.Type;

export interface TscBridge {
	transpile(source: string, fileName?: string): Promise<TranspileResult>;
	checkProject(configPath: string, overrides?: ProjectOverrides): Promise<readonly Diagnostic[]>;
	/** Entrypoints are relative to the configuration file's directory. */
	exportedCodeUnions(
		configPath: string,
		entrypoints: readonly string[],
	): Promise<readonly CodeUnion[]>;
	/** Finishes queued work and shuts the compiler down. */
	close(): Promise<void>;
}

export const BridgeResponseSchema = Schema.Struct({
	...TranspileResultSchema.fields,
	unions: Schema.Array(CodeUnionSchema),
});
export type BridgeResponse = typeof BridgeResponseSchema.Type;

export const BridgeRequestSchema = Schema.Union([
	Schema.Struct({
		method: Schema.Literal('transpile'),
		source: Schema.String,
		fileName: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		method: Schema.Literal('checkProject'),
		configPath: Schema.String,
		...ProjectOverridesSchema.fields,
	}),
	Schema.Struct({
		method: Schema.Literal('exportedCodeUnions'),
		configPath: Schema.String,
		entrypoints: Schema.Array(Schema.String),
	}),
]);
export type BridgeRequest = typeof BridgeRequestSchema.Type;

export const WireResponseSchema = Schema.Union([
	Schema.Struct({ id: Schema.Int, error: Schema.String }),
	Schema.Struct({ id: Schema.Int, ...BridgeResponseSchema.fields }),
]);
export type WireResponse = typeof WireResponseSchema.Type;

const decodeWireResponse = Schema.decodeUnknownSync(Schema.fromJsonString(WireResponseSchema));
const decodeRequest = Schema.decodeUnknownSync(BridgeRequestSchema);

export function encodeRequest(id: number, request: BridgeRequest): string {
	return JSON.stringify({ id, ...decodeRequest(request) });
}

export type DecodedResponse =
	| { readonly id: number; readonly ok: true; readonly response: BridgeResponse }
	| { readonly id: number; readonly ok: false; readonly error: string };

/** Decodes the Go response and separates compiler failures from results. */
export function decodeResponse(text: string): DecodedResponse {
	const value = decodeWireResponse(text);
	if ('error' in value) return { id: value.id, ok: false, error: value.error };
	const { id, ...response } = value;
	return { id, ok: true, response };
}

/** Parses the response to request `id`, throwing its error if it carries one. */
export function readResponse(text: string, id: number): BridgeResponse {
	const decoded = decodeResponse(text);
	if (decoded.id !== id) throw new Error('Invalid helper response');
	if (!decoded.ok) throw new Error(decoded.error);
	return decoded.response;
}

/** Builds the bridge API over any transport that sends a request and resolves its response. */
export function clientFor(
	request: (payload: BridgeRequest) => Promise<BridgeResponse>,
	close: () => Promise<void>,
): TscBridge {
	return {
		async transpile(source, fileName) {
			const { outputText, diagnostics } = await request({ method: 'transpile', source, fileName });
			return { outputText, diagnostics };
		},
		async checkProject(configPath, overrides = {}) {
			const { files, compilerOptions, runExternalCode } = overrides;
			return (
				await request({
					method: 'checkProject',
					configPath,
					files,
					compilerOptions,
					runExternalCode,
				})
			).diagnostics;
		},
		async exportedCodeUnions(configPath, entrypoints) {
			return (await request({ method: 'exportedCodeUnions', configPath, entrypoints })).unions;
		},
		close,
	};
}

/** Effect API shared by the native and WASM transports. */
export interface Compiler {
	transpile(source: string, fileName?: string): Effect.Effect<TranspileResult, Error>;
	checkProject(
		configPath: string,
		overrides?: ProjectOverrides,
	): Effect.Effect<readonly Diagnostic[], Error>;
	exportedCodeUnions(
		configPath: string,
		entrypoints: readonly string[],
	): Effect.Effect<readonly CodeUnion[], Error>;
	readonly close: Effect.Effect<void, Error>;
}

export function compilerFor(
	request: (payload: BridgeRequest) => Effect.Effect<BridgeResponse, Error>,
	close: Effect.Effect<void, Error>,
): Compiler {
	return {
		transpile: (source, fileName) =>
			request({ method: 'transpile', source, fileName }).pipe(
				Effect.map(({ outputText, diagnostics }) => ({ outputText, diagnostics })),
			),
		checkProject: (configPath, overrides = {}) =>
			request({ method: 'checkProject', configPath, ...overrides }).pipe(
				Effect.map(({ diagnostics }) => diagnostics),
			),
		exportedCodeUnions: (configPath, entrypoints) =>
			request({ method: 'exportedCodeUnions', configPath, entrypoints }).pipe(
				Effect.map(({ unions }) => unions),
			),
		close,
	};
}

export function promiseClientFor(compiler: Compiler): TscBridge {
	return {
		transpile: (source, fileName) => Effect.runPromise(compiler.transpile(source, fileName)),
		checkProject: (configPath, overrides) =>
			Effect.runPromise(compiler.checkProject(configPath, overrides)),
		exportedCodeUnions: (configPath, entrypoints) =>
			Effect.runPromise(compiler.exportedCodeUnions(configPath, entrypoints)),
		close: () => Effect.runPromise(compiler.close),
	};
}
