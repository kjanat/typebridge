# Experimental TypeScript compiler in WebAssembly

The compiler of [`@kjanat/tsc-bridge`](../bridge/README.md), running inside
Node or Bun through Go's `js/wasm` target. Compiler calls execute in-process, with
no helper executable.

## Use

```ts
import { createWasmBridge } from '@kjanat/tsc-wasm';

const compiler = await createWasmBridge();
try {
	const emitted = await compiler.transpile('export const answer: number = 42;');
	const diagnostics = await compiler.checkProject('wasm/test/fixture/tsconfig.json');
	const unions = await compiler.exportedCodeUnions('wasm/test/fixture/tsconfig.json', ['index.ts']);
} finally {
	await compiler.close();
}
```

`createWasmBridge({ wasm }?)` loads `bin/tsc-bridge.wasm`, or the module at `wasm`,
and resolves to the same `TscBridge` interface as `createTscBridge`: `transpile`,
`checkProject` with its `files` and `compilerOptions` overrides, and
`exportedCodeUnions`, with identical results. With `runExternalCode`, a content
mapper whose `package.json` names a module in `tscBridge.module` runs in this
process: the loader imports the module and passes the compiler's bytes to the
`connect(send)` function it exports. Other mappers run as child processes through
`node:child_process`, and `close()` kills any that are still running. Paths resolve against the process's
working directory. Requests run concurrently, and each instance keeps its own
project cache. `close()` waits for in-flight requests, stops the Go runtime and
disposes its timers; later requests reject.

Filesystem access comes from `node:fs`, so this runs in Node and Bun. A browser
adaptation needs a virtual filesystem and should put the compiler in a Worker.
Timer cleanup uses the Go glue's internal timeout map, so it must be rechecked on
Go upgrades.

## Build and test

Requires Go 1.27+ and Node 26. From the repository root:

```sh
bun run build:go
bun run build
bun run test
```

After building, the probe also runs directly in Bun:

```sh
bun wasm/probe.ts
```

The build produces `bin/tsc-bridge.wasm` and the matching `bin/wasm_exec.js`.
Both are available locally and ignored by Git. All paths are derived from the
scripts' locations; no `/tmp` files or machine-specific paths are needed.
This directory is its own Go module. [`main.go`](./main.go) builds only for
`js/wasm` and imports `github.com/microsoft/TypeScript/tsc/protocol`, which
`go.mod` replaces with [`../protocol`](../protocol/README.md); compiler logic
stays there. The loader takes its types and client from `@kjanat/tsc-protocol`
too, and needs `@kjanat/tsc-bridge` only for the probe's comparison. The
repository's `go.work` lists the modules for editors and `go` commands run from
the root. `build.ts` builds with `GOWORK=off`, so only `go.mod` decides the
dependencies.

The probe checks:

- Emitted JavaScript executes correctly, and invalid syntax produces diagnostics.
- The standalone fixture checks without diagnostics.
- The fixture exports two known error/reason code unions; both match the expected values and the native bridge.
- Twelve concurrent transpile, project-check, override and union requests, spread
  over two instances, each return the native bridge's result for the same request.
- `close()` lets an in-flight request finish, and requests after it reject.

It reports module size, gzip size, startup time and per-request timings. The
initial standard-Go build was about 32 MiB, or 7.5 MiB gzipped; timings are
measurements of the current run.

TinyGo 0.42.0 failed to compile the native bridge with
`panic: unknown type: T`; this build uses standard Go. Newer TinyGo versions have
not been tested.
