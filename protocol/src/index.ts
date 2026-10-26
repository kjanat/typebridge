export interface Diagnostic {
	readonly code: number;
	readonly category: number;
	readonly message: string;
	/** `message` followed by its chained messages, as TypeScript prints them. */
	readonly messageText: string;
	readonly fileName?: string;
	/** Zero-based UTF-8 byte offset, matching the Go compiler. */
	readonly start: number;
	/** Length in UTF-8 bytes. */
	readonly length: number;
	readonly children?: readonly Diagnostic[];
}

export interface TranspileResult {
	readonly outputText: string;
	/** Syntactic and compiler-option diagnostics; transpilation does not typecheck. */
	readonly diagnostics: readonly Diagnostic[];
}

export interface CodeUnion {
	readonly name: string;
	readonly codes: readonly string[];
}

/** Applied as a tsconfig that extends the project's configuration. */
export interface ProjectOverrides {
	/** Replaces the project's root files. Paths are relative to the configuration file's directory. */
	readonly files?: readonly string[];
	/** tsconfig `compilerOptions` layered over the project's own. */
	readonly compilerOptions?: Readonly<Record<string, unknown>>;
	/** Runs the content mappers the project configures, like `tsc --runExternalCode`. */
	readonly runExternalCode?: boolean;
}

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

export interface BridgeResponse extends TranspileResult {
	readonly unions: readonly CodeUnion[];
}

export type BridgeRequest =
	| { readonly method: 'transpile'; readonly source: string; readonly fileName?: string }
	| ({ readonly method: 'checkProject'; readonly configPath: string } & ProjectOverrides)
	| {
			readonly method: 'exportedCodeUnions';
			readonly configPath: string;
			readonly entrypoints: readonly string[];
	  };

export type DecodedResponse =
	| { readonly id: number; readonly ok: true; readonly response: BridgeResponse }
	| { readonly id: number; readonly ok: false; readonly error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDiagnostic(value: unknown): value is Diagnostic {
	return (
		isRecord(value) &&
		typeof value.code === 'number' &&
		typeof value.category === 'number' &&
		typeof value.message === 'string' &&
		typeof value.messageText === 'string' &&
		typeof value.start === 'number' &&
		typeof value.length === 'number' &&
		(value.fileName === undefined || typeof value.fileName === 'string') &&
		(value.children === undefined ||
			(Array.isArray(value.children) && value.children.every(isDiagnostic)))
	);
}

function isCodeUnion(value: unknown): value is CodeUnion {
	return (
		isRecord(value) &&
		typeof value.name === 'string' &&
		Array.isArray(value.codes) &&
		value.codes.every((code: unknown) => typeof code === 'string')
	);
}

/** Parses one serialized response, rejecting anything that is not a well-formed response. */
export function decodeResponse(text: string): DecodedResponse {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || typeof value.id !== 'number') throw new Error('Invalid helper response');
	const { id } = value;
	if (typeof value.error === 'string') return { id, ok: false, error: value.error };
	const { outputText, diagnostics, unions } = value;
	if (
		typeof outputText !== 'string' ||
		!Array.isArray(diagnostics) ||
		!diagnostics.every(isDiagnostic) ||
		!Array.isArray(unions) ||
		!unions.every(isCodeUnion)
	) {
		throw new Error('Invalid helper response payload');
	}
	return { id, ok: true, response: { outputText, diagnostics, unions } };
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
