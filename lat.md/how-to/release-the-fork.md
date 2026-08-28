# Releasing the fork

Cutting a release and installing the result. The reasoning behind each rule is in [[fork-publishing#Publishing]].

## Release Process

Cutting a release is a deliberate act, triggered by a tag rather than by a merge.

1. **Write the notes** — `.github/release-notes/vX.Y.Z-fork.N.md`, saying what changed and why. Optional but expected; see [[fork-publishing#Publishing#Release notes]]
2. **Bump the version** — `version` in the root `package.json`, keeping the `-fork.N` suffix. Commit message: `Bump to X.Y.Z-fork.N`
3. **Verify green** — `pnpm buildall && pnpm test`, and `lat check` on this repository's own `lat.md/`
4. **Tag** — `git tag vX.Y.Z-fork.N` and push the tag. The tag must match `package.json` exactly; [[fork-publishing#Publishing#Release Workflow]] refuses the release otherwise
5. **Install anywhere** — `npm i -g` against the release asset URL

Each release carries the tarball twice: under its versioned name, and again as `lat.md-latest.tgz`. GitHub's `/releases/latest/` redirect resolves the release but not an asset name, so a version-free URL needs a version-free asset to point at:

```
npm i -g https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The versioned URL stays available for pinning. `latest` follows whichever release GitHub considers current, which excludes any release marked as a prerelease — the `-fork.N` suffix in the version does not itself mark one.

The two `@lat.md/*` packages are never bumped or published here. They are upstream's, unmodified, and already released.

## Two install routes

Both serve the same build.

```
mise settings add minimum_release_age_excludes npm:@plebeiantech/lat.md
mise use -g npm:@plebeiantech/lat.md@latest
```

The `settings add` line is not optional. mise's `minimum_release_age` quarantines packages published within the last few days, and a fork release is always inside that window — so without the waiver mise filters out every candidate version and fails with `no versions found for npm:@plebeiantech/lat.md matching date filter`, which reads as if the package does not exist. Pinning an older version does not help; they are all too new. The waiver is permanent by necessity, and waiving an age check on a package you publish yourself is what the setting is for.

```
npm i -g --prefix ~/.local/lat https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

The second wants `~/.local/lat/bin` on `PATH`. A fixed prefix rather than the default global one keeps that install independent of the active Node version, which a version manager would otherwise change underneath it.

The two routes must not both be live on one machine. `~/.local/lat/bin` is prepended to `PATH`, so a Release-route install shadows a mise-managed one, and `mise upgrade` then reports a version the shell never runs.
