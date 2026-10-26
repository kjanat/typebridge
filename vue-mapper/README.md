# Vue content mapper

Type-checks Vue single-file components with the TypeScript compiler of
[`@kjanat/tsc-bridge`](../bridge/README.md). It implements TypeScript's content
mapper protocol. The compiler starts `node dist/server.mjs` and asks it to turn each
`.vue` file into TypeScript with `@vue/language-core`, the code generator behind
vue-tsc.

## Use

Declare the mapper in the project's tsconfig:

```json
{
	"contentMappers": [{ "package": "@kjanat/tsc-vue-mapper", "extensions": [".vue"] }]
}
```

Then check the project with external code enabled:

```ts
import { checkProjectSync, formatDiagnostic } from '@kjanat/tsc-bridge';

for (const diagnostic of checkProjectSync('tsconfig.json', { runExternalCode: true })) {
	console.log(formatDiagnostic(diagnostic, process.cwd()));
}
```

Vue options come from `vueCompilerOptions` in that configuration and the
configurations it extends. The native bridge starts the mapper as
`node dist/server.mjs`, so `node` must be on `PATH`. The WebAssembly bridge imports
`dist/index.mjs`, named by `tscBridge.module`, and runs the mapper inside the
calling process through `connect(send)`.

`@vue/language-core` parses `<script>` blocks and reads `vueCompilerOptions`
through TypeScript 6's synchronous JavaScript API, which TypeScript 7 does not
ship. The mapper hands it [`@kjanat/tsc-compat`](../compat/README.md), which
serves that API from the bridge's own compiler.

## Diagnostics

The upstream protocol hides diagnostics by virtual range, for every error code
alike. vue-tsc decides per diagnostic: some generated code hides only certain
codes, and `@vue-expect-error` counts the errors it hides. This package sets
`tscBridge.verify` in its `package.json`, so the bridge starts a second instance
of the mapper and sends it the compiler's diagnostics. That instance regenerates
each component, places every diagnostic with Volar's own source map and
verification rules, and rejects the request if its generated code differs from
the code the compiler checked.

Without the bridge, for example under `tsc --runExternalCode`, only the range
rules apply. Positions can then differ from vue-tsc and `@vue-expect-error` has
no effect.

## Test

With the bridge built, from this directory:

```sh
bun test
```

The test checks [`test/fixture`](./test/fixture) and expects the exact output of
vue-tsc 3.3.11 on TypeScript 6.0.3 for the same files.
