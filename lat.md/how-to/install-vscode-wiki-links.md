---
lat:
  mode: how-to
---
# Installing the VS Code Wiki Links Extension

Procedure for building the lat wiki links extension as a local `.vsix` file and installing it in VS Code.

1. **Build the package** — run `pnpm install`, then `pnpm --filter vscode-wiki-links package`.
2. **Install the extension** — run `code --install-extension packages/vscode-wiki-links/vscode-wiki-links-VERSION.vsix`, or use Extensions: Install from VSIX.
3. **Point VS Code at lat** — set `latWikiLinks.latPath` in User settings if VS Code cannot find `lat`, or if your `lat` has no `resolve` command.
4. **Trust the workspace** — links work only in a trusted workspace.

## Build the package

Run these commands from the repository root. The package command builds the bundle, then runs `vsce` through `pnpm dlx`. It writes the `.vsix` into `packages/vscode-wiki-links/`.

```bash
pnpm install
pnpm --filter vscode-wiki-links package
```

## Install the extension

Replace `VERSION` with the version in `packages/vscode-wiki-links/package.json`.

```bash
code --install-extension packages/vscode-wiki-links/vscode-wiki-links-VERSION.vsix
```

## Set the lat path

The extension runs [[cli#resolve]] for each link. It needs a lat release that includes `resolve`. Check with `lat resolve --help`.

Set `latWikiLinks.latPath` in User settings in two cases: VS Code does not inherit your shell PATH, or your installed lat lacks `resolve`. The setting has machine scope. VS Code ignores it in a workspace's `.vscode/settings.json`.

If your lat lacks `resolve`, point the setting at a wrapper script that runs the lat built from this repository:

```sh
#!/bin/sh
exec node REPO/dist/src/cli/index.js "$@"
```

## Trust the workspace

The extension runs the lat binary when you click a link. It stays off in untrusted workspaces. Trust the workspace, then reload the window if links do not appear.
