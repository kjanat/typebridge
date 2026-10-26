# TypeScript compiler bridge protocol

The request/response contract shared by the native bridge
([`@kjanat/tsc-bridge`](../bridge/README.md)) and the WebAssembly bridge
([`@kjanat/tsc-wasm`](../wasm/README.md)). Both halves of the contract live here:

- **Go**, module `github.com/microsoft/TypeScript/tsc/protocol`: `Request`,
  `Response` and `Handle`, which answers a request with the compiler and
  keeps each project's parsed files and per-file diagnostics between requests.
- **TypeScript**, package `@kjanat/tsc-protocol`: the matching wire types, the
  `TscBridge` interface, `decodeResponse` and `readResponse` to validate
  serialized responses, and `clientFor(request, close)`, which builds a
  `TscBridge` over any transport.

Each transport supplies only its own entry point and delivery: stdin/stdout for
the native helper, a JS global for WebAssembly.

## Content mappers

A `checkProject` request with `runExternalCode` starts the content mappers the
project's tsconfig declares, through upstream's content mapper host. Mapped files
are transformed once per content change and cached with the project.

Mapper processes start through `os/exec` unless the embedder calls `SetSpawner`.
The WebAssembly entry point passes one that asks its JavaScript host for the
connection.

Upstream places a diagnostic in a mapped file through the mapper's span map.
A mapper can take over placement by setting `"tscBridge": { "verify": true }` in
its `package.json`. `Handle` then starts a second instance of the mapper and
sends it one JSON-RPC `verify` request per check, framed like the upstream
protocol:

```json
{
	"configFileName": "/abs/tsconfig.json",
	"options": {},
	"files": [
		{
			"fileName": "/abs/App.vue",
			"content": "<original text>",
			"virtualText": "<generated text the compiler checked>",
			"diagnostics": [{ "start": 120, "length": 4, "code": 2322 }]
		}
	]
}
```

The result holds one array per file and one entry per diagnostic: a
`{ "start", "length" }` span in the original text, or `null` to drop the
diagnostic. Offsets on both sides are UTF-16 code units. `options` carries the
`options` of the mapper's `contentMappers` entry, when it has any.

The Go package imports TypeScript's compiler, checker, and transpiler directly.
Its module path sits under `github.com/microsoft/TypeScript/tsc`, which satisfies
Go's `internal` import rule. The upstream module is a normal dependency; no fork
or source patches are used.

The upstream compiler requirement is in [go.mod](./go.mod). The root
`sync:typescript` command synchronizes all four Go modules with the exact
TypeScript npm release. The Go API is internal and may change on updates.

## Test

Requires Go 1.27 or newer. From this directory:

```sh
go test -race -count=1 ./...
```

The race test sends concurrent project requests through `Handle` and requires
each result to match the sequential one.
