# @kjanat/tsc-protocol

Typed compiler and content-mapper contracts for Typebridge. Effect Schema codecs
define the messages; TypeScript types are inferred from those schemas. Use this
package to implement a transport, integrate a mapper, or decode bridge messages.

For a ready-to-use compiler, install
[@kjanat/tsc-bridge](https://www.npmjs.com/package/@kjanat/tsc-bridge) or
[@kjanat/tsc-wasm](https://www.npmjs.com/package/@kjanat/tsc-wasm).

## Install

```sh
npm install @kjanat/tsc-protocol effect
```

The package is ESM and declares Node.js 24+ or Bun 1.4.2+.

## Encode a request and decode its response

```typescript
import { encodeRequest, readResponse } from '@kjanat/tsc-protocol';

const request = encodeRequest(1, {
	method: 'transpile',
	source: 'export const answer: number = 42;',
	fileName: 'example.ts',
});
console.log(request);

// Pass the response text received from your transport to readResponse.
const responseText = JSON.stringify({
	id: 1,
	outputText: 'export const answer = 42;\n',
	diagnostics: [],
	unions: [],
});
const response = readResponse(responseText, 1);
console.log(response.outputText);
```

`encodeRequest(id, request)` checks the request fields and returns JSON text.
`readResponse(text, id)` decodes the response, checks its ID and throws if it carries
a compiler error. `decodeResponse(text)` exposes the result as an `ok` union:
`{ id, ok: true, response }` or `{ id, ok: false, error }`. Malformed messages throw
schema errors.

## Compiler contracts

| Request method       | Inputs                                                               | Result exposed by the client  |
| -------------------- | -------------------------------------------------------------------- | ----------------------------- |
| `transpile`          | `source`, optional `fileName`                                        | `{ outputText, diagnostics }` |
| `checkProject`       | `configPath`, optional `files`, `compilerOptions`, `runExternalCode` | Diagnostic array.             |
| `exportedCodeUnions` | `configPath`, `entrypoints`                                          | Array of `{ name, codes }`.   |

The success wire envelope contains `id`, `outputText`, `diagnostics` and `unions`.
An error envelope contains `id` and `error`. Native helpers exchange one JSON
message per line; the WASM ABI passes the same JSON text to `invoke`.

Exported schemas are `BridgeRequestSchema`, `BridgeResponseSchema`,
`WireResponseSchema`, `DiagnosticSchema`, `TranspileResultSchema`, `CodeUnionSchema`
and `ProjectOverridesSchema`. They can be composed with Effect Schema:

```typescript
import { Schema } from 'effect';
import { BridgeRequestSchema } from '@kjanat/tsc-protocol';

const decode = Schema.decodeUnknownSync(BridgeRequestSchema);
const request = decode({ method: 'checkProject', configPath: './tsconfig.json' });
console.log(request);
```

## Build a client over your transport

`clientFor(request, close)` constructs the Promise-based `TscBridge` interface.
Its `request` callback receives a `BridgeRequest` and resolves a decoded
`BridgeResponse`; `close` performs transport cleanup.

`compilerFor(request, close)` constructs the Effect-based `Compiler` interface.
Its request callback returns `Effect<BridgeResponse, Error>` and its close argument
is an `Effect<void, Error>`. `promiseClientFor(compiler)` adapts that compiler to
`TscBridge`. The transport owns framing, IDs, resource acquisition and shutdown.

Both clients expose `transpile`, `checkProject`, `exportedCodeUnions` and `close`.
The Effect client's `close` is an Effect value; the Promise client's `close()` is
a method.

## Content-mapper messages

Mappers exchange JSON-RPC 2.0 messages framed with `Content-Length` headers. The
request methods are `initialize`, `openProject`, `closeProject`, `transform` and
`verify`. `decodeMapperMessage(text)` decodes a JSON message body;
`encodeMapperResponse(response)` produces a JSON response body. Framing is the
transport's responsibility.

Exported codecs include `MapperRequestSchema`, `MapperResponseSchema`,
`MapperResultSchema`, `MapperTransformParamsSchema` and `MapperVerifyParamsSchema`.
Their associated types describe parameters, results, source spans and mapping
segments. An in-process mapper implements `MapperModule.connect(send)` and returns
a `MapperConnection` with `receive(chunk)`; chunks are `Uint8Array` values.

A mapper's `tscBridge.verify` package metadata enables diagnostic verification.
The bridge sends `configFileName`, optional mapper `options` and a `files` array.
Each file contains `fileName`, original `content`, generated `virtualText` and
`diagnostics` with `start`, `length` and `code`. The result has one array per file
and one entry per diagnostic: an original-source `{ start, length }` span, or
`null` to discard that diagnostic.

## Positions

Compiler diagnostics use zero-based UTF-8 byte offsets. Mapper transformations
and verification messages use UTF-16 code units. Convert offsets at the relevant
boundary when implementing a mapper or presenting source locations.

## License

MIT. Source and the Go-side compiler handler:
[Typebridge](https://github.com/kjanat/typebridge).
