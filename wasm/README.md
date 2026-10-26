# @kjanat/tsc-wasm

[![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-wasm?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-wasm)

Run the TypeScript Go compiler as WebAssembly inside Node.js or Bun. Transpile
source, check projects and extract error-code unions through an in-process
compiler with Promise and Effect APIs.

## Install

```sh
npm install @kjanat/tsc-wasm
```

Requires Node.js 24+ or Bun 1.4.2+. The package includes the compiler module and its
Go runtime glue. Filesystem access uses Node-compatible APIs.

## Transpile and check a project

```typescript
import { createWasmBridge } from '@kjanat/tsc-wasm';

const compiler = await createWasmBridge();
try {
	const result = await compiler.transpile('export const answer: number = 42;');
	console.log(result.outputText);

	const diagnostics = await compiler.checkProject('./tsconfig.json');
	console.log(diagnostics);
} finally {
	await compiler.close();
}
```

`transpile(source, fileName?)` emits ESNext JavaScript and reports syntax and option
diagnostics. `checkProject(configPath, overrides?)` performs configuration, syntax,
global and semantic checks. It does not emit project files or recursively build
project references.

Compiler diagnostics are returned as data. Loading, request and runtime failures
reject the Promise. Each instance has its own project cache and supports concurrent
requests. `close()` waits for active work, stops the runtime and mapper processes,
and clears runtime timers. Calls after closing reject.

## Effect API

```sh
npm install effect
```

```typescript
import { Effect } from 'effect';
import { makeWasmBridge } from '@kjanat/tsc-wasm';

const diagnostics = await Effect.runPromise(
	Effect.scoped(
		Effect.gen(function* () {
			const compiler = yield* makeWasmBridge();
			return yield* compiler.checkProject('./tsconfig.json');
		}),
	),
);
console.log(diagnostics);
```

`makeWasmBridge(options?)` acquires a scoped `Compiler`. Operations return Effects
with `Error` failures. The scope manages the runtime, timers, mapper processes and
request fibers, and cleans them up after success, failure or interruption.
Request spans are named `typebridge.request`.

## Project overrides

```typescript
const diagnostics = await compiler.checkProject('./tsconfig.json', {
	files: ['src/index.ts'],
	compilerOptions: { strict: true },
	runExternalCode: true,
});
```

Config paths resolve against the process working directory. `files` replaces the
project root files and `compilerOptions` overrides the project's options. Paths in
the overrides resolve relative to the configuration file.

`runExternalCode` enables configured content mappers. Mappers with a
`tscBridge.module` entry run in-process through their `connect(send)` export.
Other mappers run as child processes. For Vue components, install and configure
[@kjanat/tsc-vue-mapper](https://www.npmjs.com/package/@kjanat/tsc-vue-mapper).

## Extract error-code unions

```typescript
const unions = await compiler.exportedCodeUnions('./tsconfig.json', ['src/index.ts']);
console.log(unions);
```

This evaluates exported string-literal unions whose names end in `ErrorCode` or
`ReasonCode`, including re-exports. Each result has a `name` and a sorted `codes`
array. Entrypoints resolve relative to the configuration file. Duplicate exports
are deduplicated; conflicting same-name unions produce an error.

## Load a custom compiler module

Both factories accept `{ wasm?: string | URL }`:

```typescript
import { createWasmBridge } from '@kjanat/tsc-wasm';

const compiler = await createWasmBridge({
	wasm: new URL('./compiler.wasm', import.meta.url),
});
```

The custom module must implement the bridge ABI and work with the included Go
runtime glue. Omit this option to use the packaged compiler.

## Shared API and diagnostics

The Promise client implements `TscBridge`; the Effect client implements `Compiler`.
These interfaces and the `Diagnostic`, `TranspileResult`, `CodeUnion` and
`ProjectOverrides` types are re-exported by this package.

Diagnostics use zero-based UTF-8 byte offsets. `message` contains the diagnostic's
own text, `messageText` includes chained messages, and `children` carries the chain
structure. The native package also provides
[`formatDiagnostic`](https://www.npmjs.com/package/@kjanat/tsc-bridge) for rendering
file locations and messages.

## License

MIT. Source and development instructions: [Typebridge](https://github.com/kjanat/typebridge).
