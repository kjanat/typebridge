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
for response correlation, deadlines and interruption. WASM requests run in a FiberSet;
shutdown waits for active requests before stopping the runtime and mapper processes.

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

## CI and package archives

Each package has its own build, typecheck, test and packing job. `protocol` and
`compat` start independently. `bridge` consumes the protocol archive; `wasm`
consumes protocol and bridge archives. The Vue mapper consumes all four, including
the bridges used by its tests. Jobs download their dependencies by artifact ID
and extract the built packages instead of rebuilding them.

Each job creates its archive with `bun pm pack --ignore-scripts` and uploads a
SHA-256 checksum alongside it. A separate consumer installs all five archives and
tests native, WASM, parser, Vue and Effect APIs under both Node and Bun. The final
`test` job checks all package results, root types, lifecycle tests, lint and format.

## Preview packages

After successful checks on PRs and master, the
[pkg.pr.new workflow](.github/workflows/pkg-pr-new.yml) publishes the prebuilt
archives and an AST explorer StackBlitz template. Preview URLs and installation
commands are posted to the PR by pkg.pr.new. The GitHub app must have access to
this repository: [install pkg.pr.new](https://github.com/apps/pkg-pr-new).

## npm staging and releases

Successful pushes to master and release tags stage the same tested archives using
`npm stage publish`, OIDC and provenance. Each package has its own staging job.
The upload jobs download the archives; they do not install project dependencies,
compile, bundle or repack them.

For a release, update all five package versions and merge the change. Master CI
uploads release candidates to npm staging. A `v<version>` tag runs the same checks
and requires every package version to match the tag before uploading. Prerelease
versions use the `next` dist-tag; other versions use `latest`.

To review and publish an uploaded candidate from an authenticated npm session:

```sh
npm stage list @kjanat/tsc-protocol
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

Approval requires 2FA. Repeat for each package, starting with `tsc-protocol` and
`tsc-compat`, then the bridges, then `tsc-vue-mapper`. To discard a candidate, use
`npm stage reject <stage-id>`.

### Configure trusted publishing

Configure each package to trust the calling workflow, `test.yml`, with environment
`npm`. Give it permission to stage packages and disable direct publication:

```sh
npm trust github @kjanat/tsc-protocol --repo kjanat/typebridge --file test.yml --environment npm --allow-stage-publish --allow-publish=false
```

Run `npm login` first; creating the connection requires 2FA. Repeat for
`tsc-bridge`, `tsc-compat`, `tsc-wasm` and `tsc-vue-mapper`.
The package must exist before its trusted-publisher connection can be configured.
For a new name, an authenticated `npm stage publish <archive.tgz> --access public`
can create its public placeholder; approve its contents after review. CI uses
stage-only OIDC credentials for subsequent uploads. The `npm` environment also
accepts an optional `NPM_TOKEN` secret, passed to npm as `NODE_AUTH_TOKEN`, for
staging before the OIDC connection is configured. The environment uses
`deployment: false`, so uploads do not create GitHub deployment records.

See npm's [staging](https://docs.npmjs.com/staged-publishing/) and
[trusted-publishing](https://docs.npmjs.com/trusted-publishers/) documentation.

## License and origin

MIT. This repository was extracted from the `tsc/` workspace in
[kjanat/micro509](https://github.com/kjanat/micro509).
