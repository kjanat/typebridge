# TypeScript 6 API on the Go compiler

`@kjanat/tsc-compat` serves the part of TypeScript 6's synchronous JavaScript API
that [`@vue/language-core`](https://github.com/vuejs/language-tools) calls, from
the TypeScript Go compiler that [`@kjanat/tsc-bridge`](../bridge/README.md) uses.
The parser and the tsconfig reader run in a WebAssembly build of that compiler,
inside the calling process.

```ts
import * as ts from '@kjanat/tsc-compat';

const file = ts.createSourceFile('/project/a.ts', 'export const a = 1;');
ts.forEachChild(file, (node) => console.log(ts.isVariableStatement(node)));
```

## API

| Export                                                                             | Backed by                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `createSourceFile`                                                                 | The compiler's parser. Each file carries its `parseDiagnostics`.  |
| `readJsonConfigFile`, `convertToObject`                                            | The compiler's JSON parser and tsconfig conversion.               |
| `parseJsonSourceFileConfigFileContent`                                             | The compiler's tsconfig reader, with `extends` read through host. |
| `forEachChild`, `getTokenPosOfNode`, `getLeadingCommentRanges`, `is*`              | `typescript/ast` of the matching npm nightly.                     |
| `SyntaxKind`, `ScriptKind`, `ScriptTarget`                                         | `typescript/ast` of the matching npm nightly.                     |
| `isFunctionLike`, `isStringLiteralLike`, `findConfigFile`, `ScriptSnapshot`, `sys` | This package.                                                     |

Nodes are TypeScript 7 nodes, so `SyntaxKind` values differ from TypeScript 6.
Code that compares kinds through this module's `SyntaxKind` works unchanged.
`createSourceFile` resolves file names against the working directory, and
`parseJsonSourceFileConfigFileContent` accepts only empty existing options.

## How it works

`build.ts` compiles [`main.go`](./main.go) to `bin/compat.wasm`, and the root `build` command
inlines it into the `dist/index.mjs` bundle that Bun and Node both import.
[`examples/tsc-compat`](../examples/tsc-compat/README.md) is an AST explorer
on Node. The preview publication includes it as a StackBlitz template.

Importing the package instantiates the module synchronously, and its exports run
synchronously, so a caller gets a parsed file back without awaiting. Text crosses
into the module as WTF-8, and the compiler returns each file in the binary AST encoding of its
`internal/api/encoder`. The `RemoteSourceFile` decoder comes from the exact
TypeScript npm version in [package.json](./package.json). The root
`sync:typescript` command keeps that npm version aligned with the Go compiler
requirements. When updating the compiler, check the decoder against its encoding
changes, including new syntax.

Host callbacks such as `readFile` run during the call, in the order TypeScript 6
makes them, which `@vue/language-core` relies on to collect `vueCompilerOptions`
from extended configurations.

## Build and test

From this directory:

```sh
bun build.ts
bun test
```
