# Releasing Typebridge

## Build, tests and previews

Build produces one tarball per package with `bun pm pack --ignore-scripts`.
Package jobs download their dependencies by artifact ID. Test consumes those
builds and runs all workspace typechecks, unit and lifecycle tests, WASM/native
parity, Go race tests, Go vet, lint and formatting. Separate consumers install the
archives under Node and Bun.

After successful Test runs on PRs and master, pkg.pr.new publishes the existing
archives and the AST explorer template. The [pkg.pr.new GitHub app](https://github.com/apps/pkg-pr-new)
needs access to this repository. Development pushes do not publish to npm.

## Prepare a draft

Update all five package versions and merge the change. Verify the target commit's
signature, create its signed version tag, and push the tag:

```sh
git verify-commit <release-commit>
git tag -s v0.0.1 <release-commit> -m 'v0.0.1'
git push origin v0.0.1
```

A `v*` tag starts Release. To prepare or retry an existing tag manually:

```sh
gh workflow run release.yml -f tag=v0.0.1
```

Release creates a GitHub draft if that tag has no release yet. An existing draft
is reused; a published release cannot be changed by this workflow. The tag's
commit must belong to master and all package versions must match the tag.

The workflow builds the tagged commit and runs the complete Test workflow. After
successful checks, it uploads these assets to the draft:

- `protocol.tgz`, `bridge.tgz`, `compat.tgz`, `wasm.tgz`, `vue-mapper.tgz`
- `SHA256SUMS`, covering every tarball and the release metadata
- `release.json`, recording the tag, commit, version, packages and build run

Retrying preparation updates the draft's assets. The workflow does not publish
the draft or upload packages to npm.

## Approve and publish

Review the draft's notes, checks and attached tarballs. When satisfied, click
**Publish release** on GitHub.

The `release.published` event starts Publish. Each package has its own publication
job with environment `npm` and OIDC authentication. It downloads its tarball from
the GitHub release, verifies its checksum, package name and version, and compares
it byte for byte with the successful release build's artifact. It then runs
`npm publish` on that exact tarball with provenance and without lifecycle scripts.
There is no compilation, bundling or packing during publication.

Prerelease versions use the `next` dist-tag; other versions use `latest`.
Rerunning a failed publication accepts an already published version only when its
npm integrity matches the approved tarball.

## Configure npm trusted publishing

Run `npm login` first. Configuring trusted publishers requires 2FA, and each
package name must already exist on npm.

Allow the publication workflow to publish, using environment `npm`:

```sh
for package in protocol bridge compat wasm vue-mapper; do
  npm trust github "@kjanat/tsc-${package}" --repo kjanat/typebridge --file publish.yml --environment npm --allow-stage-publish --allow-publish
done
```

The `npm` environment accepts an optional `NPM_TOKEN` secret as an authentication
fallback, passed to npm as `NODE_AUTH_TOKEN`. Its jobs use `deployment: false`.

The GitHub draft is the review area in this process. npm staging is a separate
registry feature whose approval requires an interactive npm session with 2FA.
See npm's [trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/).
