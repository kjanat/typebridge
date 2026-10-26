import type { Diagnostic, ParsedCommandLine } from '#schema';
import { decodeDiagnostics, decodeParsedCommandLine } from '#schema';

export type { Diagnostic, ParsedCommandLine } from '#schema';

import path from 'node:path';
import type { Node, NodeArray, SourceFile as SyntaxTree } from 'typescript/ast';
import { ScriptKind, ScriptTarget, SyntaxKind } from 'typescript/ast';
import { compiler, decodeSourceFile, encodeWtf8, unwrap } from '#runtime';
import type { ParseConfigHost } from '#sys';

export type {
	CommentRange,
	Expression,
	Identifier,
	Node,
	NodeArray,
	ObjectLiteralExpression,
	StringLiteral,
} from 'typescript/ast';
export {
	getLeadingCommentRanges,
	getTrailingCommentRanges,
	NodeFlags,
} from 'typescript/ast';
/** Token start through the typed AST API; upstream omits the internal helper from its declarations. */
export function getTokenPosOfNode(
	node: Node,
	sourceFile?: SyntaxTree,
	includeJSDoc?: boolean,
): number {
	return node.getStart(sourceFile, includeJSDoc);
}

export * from 'typescript/ast/is';
export { isTypeAssertion as isTypeAssertionExpression } from 'typescript/ast/is';
export type { FileSystemEntries, ParseConfigHost, System } from '#sys';
export { sys } from '#sys';
export { ScriptKind, ScriptTarget, SyntaxKind };

/** A parsed file and the syntax errors the parser reported for it. */
export interface SourceFile extends SyntaxTree {
	readonly parseDiagnostics: readonly Diagnostic[];
}

export type CompilerOptions = Readonly<Record<string, unknown>>;

export interface TextChangeRange {
	readonly span: { readonly start: number; readonly length: number };
	readonly newLength: number;
}

export interface IScriptSnapshot {
	getText(start: number, end: number): string;
	getLength(): number;
	getChangeRange(oldSnapshot: IScriptSnapshot): TextChangeRange | undefined;
	dispose?(): void;
}

const unreadable = new WeakMap<SourceFile, Diagnostic>();

function parse(fileName: string, text: string, scriptKind: ScriptKind): SourceFile {
	const result = unwrap(compiler.parse(fileName, encodeWtf8(text), scriptKind, process.cwd()));
	const { data } = result;
	return Object.assign(decodeSourceFile(data), {
		parseDiagnostics: decodeDiagnostics(result.diagnostics),
	});
}

/** Parses one file with the compiler. The language version and `setParentNodes` are ignored. */
export function createSourceFile(
	fileName: string,
	sourceText: string,
	_languageVersion?: ScriptTarget,
	_setParentNodes?: boolean,
	scriptKind: ScriptKind = ScriptKind.Unknown,
): SourceFile {
	return parse(fileName, sourceText, scriptKind);
}

export function forEachChild<T>(
	node: Node,
	cbNode: (node: Node) => T,
	cbNodes?: (nodes: NodeArray<Node>) => T,
): T | undefined {
	return node.forEachChild(cbNode, cbNodes);
}

const functionLikeKinds: ReadonlySet<SyntaxKind> = new Set([
	SyntaxKind.FunctionDeclaration,
	SyntaxKind.MethodDeclaration,
	SyntaxKind.Constructor,
	SyntaxKind.GetAccessor,
	SyntaxKind.SetAccessor,
	SyntaxKind.FunctionExpression,
	SyntaxKind.ArrowFunction,
	SyntaxKind.MethodSignature,
	SyntaxKind.CallSignature,
	SyntaxKind.JSDocSignature,
	SyntaxKind.ConstructSignature,
	SyntaxKind.IndexSignature,
	SyntaxKind.FunctionType,
	SyntaxKind.ConstructorType,
]);

export function isFunctionLike(node: Node | undefined): boolean {
	return node !== undefined && functionLikeKinds.has(node.kind);
}

export function isStringLiteralLike(node: Node): boolean {
	return (
		node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
	);
}

/** Reads and parses a JSON configuration file. A file that cannot be read parses as empty and carries the read error. */
export function readJsonConfigFile(
	fileName: string,
	readFile: (path: string) => string | undefined,
): SourceFile {
	let text: string | undefined;
	let messageText = `Cannot read file '${fileName}'.`;
	let code = 5083;
	try {
		text = readFile(fileName);
	} catch (error) {
		messageText = `Cannot read file '${fileName}': ${error instanceof Error ? error.message : String(error)}.`;
		code = 5012;
	}
	if (text !== undefined) return parse(fileName, text, ScriptKind.JSON);
	const diagnostic: Diagnostic = { code, category: 1, messageText };
	const file = Object.assign(parse(fileName, '', ScriptKind.JSON), {
		parseDiagnostics: [diagnostic],
	});
	unreadable.set(file, diagnostic);
	return file;
}

/** Converts a parsed JSON configuration file to its value and appends conversion errors to `errors`. */
export function convertToObject(sourceFile: SourceFile, errors: Diagnostic[]): unknown {
	const result = unwrap(
		compiler.toObject(sourceFile.fileName, encodeWtf8(sourceFile.text), process.cwd()),
	);
	errors.push(...decodeDiagnostics(result.diagnostics));
	return JSON.parse(result.value);
}

function bridge(host: ParseConfigHost): object {
	return {
		useCaseSensitiveFileNames: host.useCaseSensitiveFileNames,
		fileExists: (path: string) => host.fileExists(path),
		readFile(path: string) {
			const text = host.readFile(path);
			return text === undefined ? undefined : encodeWtf8(text);
		},
		...(host.directoryExists && {
			directoryExists: (path: string) => host.directoryExists?.(path),
		}),
		...(host.realpath && { realpath: (path: string) => host.realpath?.(path) }),
		...(host.getAccessibleFileSystemEntries && {
			getAccessibleFileSystemEntries: (path: string) => host.getAccessibleFileSystemEntries?.(path),
		}),
		...(host.getCurrentDirectory && { getCurrentDirectory: () => host.getCurrentDirectory?.() }),
	};
}

/**
 * Resolves a parsed tsconfig file, including the configurations it extends,
 * through `host`. Existing options are not supported and must be empty.
 */
export function parseJsonSourceFileConfigFileContent(
	sourceFile: SourceFile,
	host: ParseConfigHost,
	basePath: string,
	existingOptions?: CompilerOptions,
	configFileName?: string,
): ParsedCommandLine {
	if (existingOptions !== undefined && Object.keys(existingOptions).length > 0) {
		throw new Error('parseJsonSourceFileConfigFileContent does not support existing options');
	}
	const result = unwrap(
		compiler.parseConfig(
			sourceFile.fileName,
			encodeWtf8(sourceFile.text),
			basePath,
			configFileName ?? '',
			bridge(host),
		),
	);
	const value = decodeParsedCommandLine(result.value);
	const failure = unreadable.get(sourceFile);
	return failure === undefined ? value : { ...value, errors: [failure, ...value.errors] };
}

export function findConfigFile(
	searchPath: string,
	fileExists: (fileName: string) => boolean,
	configName = 'tsconfig.json',
): string | undefined {
	let directory = searchPath;
	for (;;) {
		const fileName = path.posix.join(directory, configName);
		if (fileExists(fileName)) return fileName;
		const parent = path.posix.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export const ScriptSnapshot = {
	fromString(text: string): IScriptSnapshot {
		return {
			getText: (start, end) => text.substring(start, end),
			getLength: () => text.length,
			getChangeRange: () => undefined,
		};
	},
};
