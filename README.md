# Typebridge

Native and WebAssembly access to the TypeScript Go compiler from JavaScript tooling.

| Package                                          | Version                                                                                                                                             | Purpose                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`@kjanat/tsc-protocol`](protocol/README.md)     | [![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-protocol?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-protocol)     | Shared request/response contract and Go request handler.           |
| [`@kjanat/tsc-bridge`](bridge/README.md)         | [![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-bridge?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-bridge)         | Native compiler process with synchronous and asynchronous clients. |
| [`@kjanat/tsc-wasm`](wasm/README.md)             | [![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-wasm?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-wasm)             | The same compiler running as WebAssembly inside Node or Bun.       |
| [`@kjanat/tsc-compat`](compat/README.md)         | [![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-compat?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-compat)         | Synchronous TypeScript 6 parser API backed by the Go compiler.     |
| [`@kjanat/tsc-vue-mapper`](vue-mapper/README.md) | [![NPM Version](https://img.shields.io/npm/v/@kjanat/tsc-vue-mapper?logo=npm&labelColor=CB3837&color=black)](https://npm.im/@kjanat/tsc-vue-mapper) | Vue single-file component type checking through content mappers.   |

The compiler packages use the TypeScript npm version in the `ts7` catalog.
`bun run sync:typescript` resolves that npm release's exact upstream commit and updates
all four Go modules together. Their module paths intentionally live beneath
`github.com/microsoft/TypeScript/tsc` to access upstream's Go `internal` packages.

## Development

Requires Bun 1.4.2 or newer, Node 24 or newer, and Go 1.27 or newer.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test
bun run lint
```

The install hook builds the native helper, both WebAssembly modules and the five
JavaScript packages. `bun run build:go` rebuilds the Go artifacts;
`bun run build` bundles the JavaScript and declarations with tsdown.

`bun run test` includes the unit suites, native/WASM parity probe, Go protocol tests
and native helper checks. The Vue fixtures test the native and WASM transports
against the same expected diagnostics.

## Effect API

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
```

`makeTscBridge` and `makeWasmBridge` acquire scoped compiler resources. Their
operations return Effects with typed failures. Scope completion closes the process
or WASM instance after success, failure or interruption. Native requests use Deferreds
for response correlation, deadlines and interruption. WASM requests run in a FiberSet.
Explicit `close()` waits for active requests. Scope teardown stops mapper processes,
cancels request workers and shuts down the WASM runtime.

## Promise API

```typescript
import { createTscBridge } from '@kjanat/tsc-bridge';

const compiler = createTscBridge();
try {
	console.log(await compiler.transpile('export const answer: number = 42;'));
} finally {
	await compiler.close();
}
```

The Promise factories manage an Effect scope until `close()`. The native package
also exports `transpileSync`, `checkProjectSync`, and `formatDiagnostic`.

## Message schemas

The protocol package defines Effect Schema codecs for compiler requests, responses,
diagnostics, code unions and mapper RPC messages. TypeScript message types are
inferred from these schemas. Each transport decodes at its input boundary; mapper
responses are encoded through their result schema. The compatibility package has
schemas for its parser diagnostics and configuration responses.

See each package's README for its API and content-mapper configuration.

## AST explorer

```bash
cd examples/tsc-compat
bun run start
```

The demo runs the Go parser through the compatibility API and displays its syntax tree.

## Preview packages

Pull request comments include pkg.pr.new installation links and an AST explorer
StackBlitz template for trying the proposed changes.

## License and origin

MIT. This repository was extracted from the `tsc/` workspace in
[kjanat/micro509](https://github.com/kjanat/micro509).
