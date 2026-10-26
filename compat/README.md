# @kjanat/tsc-compat

A synchronous TypeScript parser and configuration API backed by the TypeScript Go
compiler in WebAssembly. Use it for tooling that needs TypeScript-style syntax
trees and tsconfig handling, including Vue's language-core integration.

## Install

```sh
npm install @kjanat/tsc-compat
```

Requires Node.js 24+ or Bun 1.4.2+. The package includes its WebAssembly parser and
the matching TypeScript AST decoder. Importing initializes the parser; API calls
return their results synchronously.

## Parse TypeScript

```typescript
import * as ts from '@kjanat/tsc-compat';

const file = ts.createSourceFile('/project/example.ts', 'export const answer: number = 42;');

console.log(file.parseDiagnostics);
ts.forEachChild(file, (node) => {
	if (ts.isVariableStatement(node)) {
		console.log(node.getText(file));
	}
});
```

`createSourceFile(fileName, sourceText, languageVersion?, setParentNodes?, scriptKind?)`
parses with the bundled compiler. Relative filenames resolve against the working
directory. The `languageVersion` and `setParentNodes` arguments are accepted for
API compatibility; parsing follows the bundled compiler's behavior. Supply
`ScriptKind` explicitly when the filename does not identify the language.

Use this package's `SyntaxKind` values and `is*` predicates when inspecting nodes.
The nodes and numeric kinds follow the matching TypeScript 7 AST.

## Read a tsconfig

```typescript
import { dirname } from 'node:path';
import * as ts from '@kjanat/tsc-compat';

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists);
if (configPath === undefined) throw new Error('No tsconfig.json found');

const source = ts.readJsonConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonSourceFileConfigFileContent(
	source,
	ts.sys,
	dirname(configPath),
	undefined,
	configPath,
);

console.log(config.fileNames);
console.log(config.options);
console.log(config.errors);
```

The configuration reader follows `extends` through the supplied host. Host
callbacks run synchronously during the call. `basePath`, the third argument,
sets the base directory for configuration resolution; pass the directory containing
the configuration file. `existingOptions` must be empty or omitted.

## API reference

| Exports                                        | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `createSourceFile`                             | Parse source and access `parseDiagnostics`.                          |
| `forEachChild`                                 | Visit a node's direct children.                                      |
| `is*`, `isFunctionLike`, `isStringLiteralLike` | Identify syntax node kinds.                                          |
| `SyntaxKind`, `ScriptKind`, `ScriptTarget`     | AST and parser enums.                                                |
| `getTokenPosOfNode`, `getLeadingCommentRanges` | Inspect token positions and comments.                                |
| `readJsonConfigFile`, `convertToObject`        | Parse JSON configuration text and convert it to a JavaScript value.  |
| `parseJsonSourceFileConfigFileContent`         | Resolve compiler options, input files and configuration diagnostics. |
| `findConfigFile`                               | Search for a configuration file through parent directories.          |
| `ScriptSnapshot`                               | Create immutable text snapshots for language tooling.                |
| `sys`                                          | Node-compatible filesystem and system host.                          |

Types include `SourceFile`, `Node`, `CompilerOptions`, `Diagnostic`,
`ParsedCommandLine`, `ParseConfigHost`, `System`, `IScriptSnapshot` and
`TextChangeRange`.

## Scope and error handling

This package supplies the parser and configuration APIs used by Vue language-core.
For semantic project checking and JavaScript emission, use
[@kjanat/tsc-bridge](https://www.npmjs.com/package/@kjanat/tsc-bridge) or
[@kjanat/tsc-wasm](https://www.npmjs.com/package/@kjanat/tsc-wasm).

Parsing and configuration diagnostics are returned on `parseDiagnostics` and
`errors`. Diagnostic positions follow JavaScript's UTF-16 offsets. Unsupported
API arguments and runtime failures throw. The parser runtime is initialized once
per module instance and shared by its synchronous calls.

## License

MIT. Source, an AST explorer and development instructions:
[Typebridge](https://github.com/kjanat/typebridge).
