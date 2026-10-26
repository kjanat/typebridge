import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Diagnostic, Node, ParseConfigHost } from '@kjanat/tsc-compat';
import * as ts from '@kjanat/tsc-compat';

function kinds(node: Node): ts.SyntaxKind[] {
	const result: ts.SyntaxKind[] = [];
	ts.forEachChild(node, (child) => {
		result.push(child.kind);
	});
	return result;
}

test('parses with the compiler and decodes the tree in this process', () => {
	const file = ts.createSourceFile('/project/a.ts', 'const é = "x";\nexport function f() {}\n', 99);
	assert.equal(file.fileName, '/project/a.ts');
	assert.equal(file.scriptKind, ts.ScriptKind.TS);
	assert.deepEqual(kinds(file), [
		ts.SyntaxKind.VariableStatement,
		ts.SyntaxKind.FunctionDeclaration,
		ts.SyntaxKind.EndOfFile,
	]);
	const [, declaration] = file.statements;
	assert.ok(declaration !== undefined && ts.isFunctionDeclaration(declaration));
	assert.equal(ts.getTokenPosOfNode(declaration, file), 15);
	assert.ok(ts.isFunctionLike(declaration));
	assert.deepEqual(file.parseDiagnostics, []);
});

test('resolves the script kind from the file name and keeps lone surrogates', () => {
	const text = 'const s = "\uD800";\nconst t = 1;\n';
	const file = ts.createSourceFile('.tsx', text, 99);
	assert.equal(file.scriptKind, ts.ScriptKind.TSX);
	assert.equal(file.text, text);
	const [, second] = file.statements;
	assert.ok(second !== undefined);
	assert.equal(ts.getTokenPosOfNode(second, file), text.indexOf('const t'));
});

test('reports parse diagnostics in UTF-16 offsets', () => {
	const file = ts.createSourceFile('/project/b.ts', 'const ü = (', 99);
	assert.deepEqual(
		file.parseDiagnostics.map(({ start, length, code }) => ({ start, length, code })),
		[{ start: 11, length: 0, code: 1109 }],
	);
});

test('converts JSON configuration text and keeps conversion order', () => {
	const file = ts.readJsonConfigFile(
		'/project/tsconfig.json',
		() => '{ "b": 1, /* c */ "a": [true] }',
	);
	const errors: Diagnostic[] = [];
	const value = ts.convertToObject(file, errors);
	assert.ok(typeof value === 'object' && value !== null);
	assert.deepEqual(Object.entries(value), [
		['b', 1],
		['a', [true]],
	]);
	assert.deepEqual(errors, []);
});

test('carries the read error of a configuration file it cannot read', () => {
	const file = ts.readJsonConfigFile('/project/missing.json', () => undefined);
	assert.deepEqual(file.parseDiagnostics, [
		{ code: 5083, category: 1, messageText: "Cannot read file '/project/missing.json'." },
	]);
	const parsed = ts.parseJsonSourceFileConfigFileContent(file, host({}).host, '/project');
	assert.equal(parsed.errors[0]?.code, 5083);
});

function host(files: Readonly<Record<string, string>>): {
	readonly host: ParseConfigHost;
	readonly reads: string[];
} {
	const reads: string[] = [];
	return {
		reads,
		host: {
			useCaseSensitiveFileNames: true,
			fileExists: (path) => path in files,
			readFile(path) {
				reads.push(path);
				return files[path];
			},
			directoryExists: (path) => Object.keys(files).some((name) => name.startsWith(`${path}/`)),
			getCurrentDirectory: () => '/project',
		},
	};
}

test('resolves extended configurations through the host', () => {
	const { host: configHost, reads } = host({
		'/project/tsconfig.json': '{ "extends": "./base.json", "compilerOptions": { "strict": true } }',
		'/project/base.json': '{ "compilerOptions": { "noEmit": true }, "vueCompilerOptions": {} }',
	});
	const file = ts.readJsonConfigFile('/project/tsconfig.json', configHost.readFile);
	const parsed = ts.parseJsonSourceFileConfigFileContent(
		file,
		configHost,
		'/project',
		{},
		'/project/tsconfig.json',
	);
	assert.deepEqual(reads, ['/project/tsconfig.json', '/project/base.json']);
	assert.equal(parsed.options.strict, true);
	assert.equal(parsed.options.noEmit, true);
	assert.throws(
		() => ts.parseJsonSourceFileConfigFileContent(file, configHost, '/project', { strict: true }),
		/existing options/,
	);
});

test('finds the nearest configuration file walking up', () => {
	const found = ts.findConfigFile('/a/b/c', (name) => name === '/a/tsconfig.json');
	assert.equal(found, '/a/tsconfig.json');
	assert.equal(
		ts.findConfigFile('/a/b', () => false),
		undefined,
	);
});

test('snapshots slice the text they were made from', () => {
	const snapshot = ts.ScriptSnapshot.fromString('abcdef');
	assert.equal(snapshot.getText(1, 3), 'bc');
	assert.equal(snapshot.getLength(), 6);
	assert.equal(snapshot.getChangeRange(snapshot), undefined);
});

test('uses the supplied config name for jsconfig defaults and relative paths', () => {
	const { host: configHost } = host({});
	const source = ts.readJsonConfigFile('/project/source.json', () => '{ "files": ["app.js"] }');
	const parsed = ts.parseJsonSourceFileConfigFileContent(
		source,
		configHost,
		'/project',
		{},
		'nested/jsconfig.json',
	);
	assert.equal(parsed.options.allowJs, true);
	assert.deepEqual(parsed.fileNames, ['/project/nested/app.js']);
});

test('decodes source-phase imports with the compiler-matched AST decoder', () => {
	const file = ts.createSourceFile(
		'/project/source.ts',
		'import source wasm from "./module.wasm";',
		99,
	);
	const [statement] = file.statements;
	assert.ok(statement !== undefined && ts.isImportDeclaration(statement));
	assert.equal(statement.importClause?.phaseModifier, ts.SyntaxKind.SourceKeyword);
	assert.deepEqual(file.parseDiagnostics, []);
});

test('exposes TS6 assertion and declaration flags used by Vue bindings', () => {
	const file = ts.createSourceFile('/project/assertion.ts', 'const value = <number>1;', 99);
	const statement = file.statements[0];
	assert.ok(statement !== undefined && ts.isVariableStatement(statement));
	assert.ok(statement.declarationList.flags & ts.NodeFlags.Const);
	const initializer = statement.declarationList.declarations[0]?.initializer;
	assert.ok(initializer !== undefined && ts.isTypeAssertionExpression(initializer));
	assert.equal(initializer.expression.kind, ts.SyntaxKind.NumericLiteral);
	assert.equal(ts.isTypeAssertionExpression(statement), false);
});
