# @kjanat/tsc-bridge

Run the TypeScript Go compiler from Node.js or Bun. Transpile source, check a
project, and extract exported string-literal error codes through a persistent
native compiler process.

## Install

```sh
npm install @kjanat/tsc-bridge
```

Requires Node.js 24+ or Bun 1.4.2+. The package includes a compiled helper; its
operating system and architecture must match your machine. Use
[@kjanat/tsc-wasm](https://www.npmjs.com/package/@kjanat/tsc-wasm) for an in-process
WebAssembly compiler, or supply your own native helper with `executable`.

## Transpile and check a project

```typescript
import { createTscBridge, formatDiagnostic } from '@kjanat/tsc-bridge';

const compiler = createTscBridge();
try {
	const result = await compiler.transpile('export const answer: number = 42;');
	console.log(result.outputText);

	const diagnostics = await compiler.checkProject('./tsconfig.json');
	for (const diagnostic of diagnostics) {
		console.log(formatDiagnostic(diagnostic, process.cwd()));
	}
} finally {
	await compiler.close();
}
```

`transpile` emits ESNext JavaScript and returns syntax and option diagnostics.
`checkProject` performs configuration, syntax, global and semantic checks using
your project's compiler options. Project checking does not emit files or build
referenced projects recursively.

Compiler diagnostics are returned as data. Request, process and transport failures
reject the Promise. Always await `close()` to finish queued work and shut down the
helper. Requests on one instance execute sequentially. Reuse an instance across
checks to benefit from its project cache; each check rereads the configuration and
source files and updates affected diagnostics.

## Effect API

```sh
npm install effect
```

```typescript
import { Effect } from 'effect';
import { makeTscBridge } from '@kjanat/tsc-bridge';

const diagnostics = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const compiler = yield* makeTscBridge();
			return yield* compiler.checkProject('./tsconfig.json');
		}),
	),
);
console.log(diagnostics);
```

`makeTscBridge(options?)` acquires a scoped `Compiler`. Its operations return Effects
with `Error` failures. Scope completion shuts down the process after success,
failure or interruption. Interrupting a request stops the helper and fails its
pending requests. Request spans are named `typebridge.request`.

## Options and project overrides

Both factories accept these options:

| Option       | Meaning                                                     | Default                         |
| ------------ | ----------------------------------------------------------- | ------------------------------- |
| `executable` | Path to a compatible native compiler helper.                | Helper included in the package. |
| `cwd`        | Working directory for the helper and relative config paths. | Caller's working directory.     |
| `timeoutMs`  | Positive per-request deadline in milliseconds.              | `60000`                         |

Project checks accept an optional second argument:

```typescript
const diagnostics = await compiler.checkProject('./tsconfig.json', {
	files: ['src/index.ts'],
	compilerOptions: { strict: true },
	runExternalCode: true,
});
```

`files` replaces the root file list. `compilerOptions` overrides the project's
options as an extending tsconfig would. File paths in those overrides resolve
relative to the configuration file. `runExternalCode` enables content mappers
declared in the tsconfig, including
[@kjanat/tsc-vue-mapper](https://www.npmjs.com/package/@kjanat/tsc-vue-mapper).

## Extract error-code unions

Given an entrypoint that exports:

```typescript
export type ParseErrorCode = 'malformed' | 'unsupported';
```

Call:

```typescript
const unions = await compiler.exportedCodeUnions('./tsconfig.json', ['src/index.ts']);
console.log(unions);
// [{ name: 'ParseErrorCode', codes: ['malformed', 'unsupported'] }]
```

Entrypoints resolve relative to the configuration file. The compiler follows
re-exports and evaluates types whose names end in `ErrorCode` or `ReasonCode`.
Results are sorted, duplicate exports are deduplicated, and conflicting unions
with the same name produce an error.

## Synchronous integrations

```typescript
import { transpileSync, checkProjectSync } from '@kjanat/tsc-bridge';

const result = transpileSync('export const answer: number = 42;', {
	fileName: 'example.ts',
});
const diagnostics = checkProjectSync('./tsconfig.json');
console.log(result.outputText, diagnostics);
```

Each synchronous call starts one helper and shuts it down afterward. These functions
accept the same helper options; `checkProjectSync` also accepts project overrides.
Output is limited to 16 MiB per call.

## Diagnostic format

Diagnostics include `code`, `category`, `message`, `messageText`, `start`, `length`,
an optional `fileName`, and optional chained `children`. Positions use zero-based
UTF-8 byte offsets. `message` is the diagnostic's own text; `messageText` includes
its indented message chain. `formatDiagnostic(diagnostic, root)` reads the source
to produce a relative path and line/column, like `tsc --pretty false`.

Shared types, including `Compiler`, `TscBridge`, `Diagnostic`, `ProjectOverrides`,
`TranspileResult` and `CodeUnion`, are re-exported by this package.

## License

MIT. Source and development instructions: [Typebridge](https://github.com/kjanat/typebridge).
