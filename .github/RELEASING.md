# Releasing Typebridge

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
[pkg.pr.new workflow](workflows/pkg-pr-new.yml) publishes the prebuilt
archives and an AST explorer StackBlitz template. Preview URLs and installation
commands are posted to the PR by pkg.pr.new. The GitHub app must have access to
this repository: [install pkg.pr.new](https://github.com/apps/pkg-pr-new).

## npm staging and releases

Successful pushes to master stage the same tested archives using
`npm stage publish`, OIDC and provenance. Each package has its own staging job.
The upload jobs download the archives; they do not install project dependencies,
compile, bundle or repack them.

For a release, update all five package versions and merge the change. Master CI
uploads release candidates to npm staging. Prerelease versions use the `next`
dist-tag; other versions use `latest`.

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

### Publish a GitHub release

After approving all five staged packages, create a release tag on the commit from
the successful master **Test** run. Verify the commit signature before tagging.
For the current `0.0.0` candidate:

```sh
git verify-commit <tested-commit>
git tag -s v0.0.0 <tested-commit> -m 'v0.0.0'
git push origin v0.0.0
gh workflow run release.yml -f tag=v0.0.0 -f build-run-id=<successful-run-id>
```

The workflow is also available under **Actions → Release → Run workflow**.
Supply the existing tag and the numeric ID of the successful Test run. The ID is
the number after `/actions/runs/` in its URL.

The release workflow:

- Checks that the tag points to the exact commit tested by that master run.
- Downloads each package archive from that run and checks its SHA-256 checksum.
- Requires every package version to match the tag and be publicly available on npm.
- Compares npm's SHA-512 integrity against each tested archive.
- Creates the GitHub release with those five tarballs, `SHA256SUMS` and generated notes.

Prereleases are marked as such. Tags do not trigger another build or staging
upload. The workflow downloads the existing archives and never rebuilds or repacks
them. npm approval happens through your authenticated npm session with 2FA.

### Configure trusted publishing

Run `npm login` first; creating these connections requires 2FA.

Staging (`test.yml`, environment `npm`):

```sh
for package in protocol bridge compat wasm vue-mapper; do
  npm trust github "@kjanat/tsc-${package}" --repo kjanat/typebridge --file test.yml --environment npm --allow-stage-publish --allow-publish=false
done
```

Release (`release.yml`, environment `npm`), with staging and publication rights:

```sh
for package in protocol bridge compat wasm vue-mapper; do
  npm trust github "@kjanat/tsc-${package}" --repo kjanat/typebridge --file release.yml --environment npm --allow-stage-publish --allow-publish
done
```

The package must exist before its trusted-publisher connection can be configured.
For a new name, an authenticated `npm stage publish <archive.tgz> --access public`
can create its public placeholder; approve its contents after review. CI uses
stage-only OIDC credentials for subsequent uploads. The `npm` environment also
accepts an optional `NPM_TOKEN` secret, passed to npm as `NODE_AUTH_TOKEN`, for
staging before the OIDC connection is configured. The environment uses
`deployment: false`, so uploads do not create GitHub deployment records.

See npm's [staging](https://docs.npmjs.com/staged-publishing/) and
[trusted-publishing](https://docs.npmjs.com/trusted-publishers/) documentation.
