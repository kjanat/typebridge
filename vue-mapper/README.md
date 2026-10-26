# @kjanat/tsc-vue-mapper

Type-check Vue single-file components with the TypeScript Go compiler. The mapper
uses Vue language-core to generate TypeScript and Volar's source maps and
verification rules to report diagnostics against your `.vue` source.

## Install

Install the mapper alongside a compiler bridge in your Vue project:

```sh
npm install --save-dev @kjanat/tsc-vue-mapper @kjanat/tsc-bridge
```

Requires Node.js 24+ or Bun 1.4.2+. Your project supplies its Vue dependency and
other libraries referenced by its components.

## Configure the project

Add a content mapper to your `tsconfig.json`:

```json
{
	"compilerOptions": {
		"strict": true,
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"target": "ESNext"
	},
	"include": ["src/**/*.ts", "src/**/*.vue"],
	"contentMappers": [{ "package": "@kjanat/tsc-vue-mapper", "extensions": [".vue"] }]
}
```

Existing `vueCompilerOptions`, including options inherited through `extends`, are
read from that configuration.

## Check Vue components

```typescript
import { createTscBridge, formatDiagnostic } from '@kjanat/tsc-bridge';

const compiler = createTscBridge();
try {
	const diagnostics = await compiler.checkProject('./tsconfig.json', {
		runExternalCode: true,
	});
	for (const diagnostic of diagnostics) {
		console.log(formatDiagnostic(diagnostic, process.cwd()));
	}
} finally {
	await compiler.close();
}
```

Set `runExternalCode: true` to enable the mapper. The native bridge launches the
packaged mapper server using `node`, which must be available on `PATH`.
Diagnostics are returned as data; compiler or mapper failures reject the request.

For a synchronous integration:

```typescript
import { checkProjectSync, formatDiagnostic } from '@kjanat/tsc-bridge';

const diagnostics = checkProjectSync('./tsconfig.json', { runExternalCode: true });
for (const diagnostic of diagnostics) {
	console.log(formatDiagnostic(diagnostic, process.cwd()));
}
```

## Use the WebAssembly bridge

```sh
npm install --save-dev @kjanat/tsc-wasm
```

```typescript
import { createWasmBridge } from '@kjanat/tsc-wasm';

const compiler = await createWasmBridge();
try {
	const diagnostics = await compiler.checkProject('./tsconfig.json', {
		runExternalCode: true,
	});
	console.log(diagnostics);
} finally {
	await compiler.close();
}
```

Use the same tsconfig. The WASM bridge imports this package's mapper module and
runs it inside the calling process. Both bridges also offer scoped Effect APIs;
pass the same `runExternalCode` option to their `checkProject` operation.

## Diagnostic behavior

The mapper applies Volar's per-diagnostic verification rules, including
`@vue-expect-error`. Typebridge uses the package's `tscBridge.verify` metadata to
request diagnostic placement after compilation. The verification step checks
that its generated TypeScript matches what the compiler checked.

The package also implements TypeScript's upstream content-mapper protocol. With
`tsc --runExternalCode`, upstream range mapping applies; Typebridge's additional
verification step supplies per-code filtering and `@vue-expect-error` handling.

## Embed the mapper

Custom hosts can import `connect`:

```typescript
import { connect } from '@kjanat/tsc-vue-mapper';

const connection = connect((chunk) => {
	// Forward these response bytes to your compiler transport.
	process.stdout.write(chunk);
});
// Feed incoming framed request bytes to connection.receive(chunk).
```

The connection consumes and produces `Uint8Array` chunks with `Content-Length`
framing and JSON-RPC 2.0 message bodies. The `tsc-vue-mapper` executable exposes the
same protocol over stdin/stdout. Most applications should configure the package
through `contentMappers` as shown above.

## License

MIT. Source and development instructions: [Typebridge](https://github.com/kjanat/typebridge).
