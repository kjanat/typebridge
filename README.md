# Typebridge

Native and WebAssembly access to the TypeScript Go compiler from JavaScript tooling.

| Package                                          | Purpose                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| [`@kjanat/tsc-protocol`](protocol/README.md)     | Shared request/response contract and Go request handler.           |
| [`@kjanat/tsc-bridge`](bridge/README.md)         | Native compiler process with synchronous and asynchronous clients. |
| [`@kjanat/tsc-wasm`](wasm/README.md)             | The same compiler running as WebAssembly inside Node or Bun.       |
| [`@kjanat/tsc-compat`](compat/README.md)         | Synchronous TypeScript 6 parser API backed by the Go compiler.     |
| [`@kjanat/tsc-vue-mapper`](vue-mapper/README.md) | Vue single-file component type checking through content mappers.   |

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

## Using the bridge

```typescript
import { createTscBridge } from '@kjanat/tsc-bridge';

const compiler = createTscBridge();
try {
	const result = await compiler.transpile('export const answer: number = 42;');
	console.log(result.outputText);
	console.log(await compiler.checkProject('./tsconfig.json'));
} finally {
	await compiler.close();
}
```

The WASM transport exposes the same asynchronous interface through
`createWasmBridge` from `@kjanat/tsc-wasm`. The native package also exports
`transpileSync`, `checkProjectSync`, and `formatDiagnostic` for synchronous tooling.
See each package's README for its full API and content-mapper configuration.

## AST explorer

```bash
cd examples/tsc-compat
bun run start
```

The demo runs the Go parser through the compatibility API and displays its syntax tree.

## Preview packages

CI builds and tests all five packages. Pushes to master publish built preview packages
through pkg.pr.new. Consumers install the published packages, including their compiled
Go artifacts; consumers do not need this repository's Go build setup.

## License and origin

MIT. This repository was extracted from the `tsc/` workspace in
[kjanat/micro509](https://github.com/kjanat/micro509).
