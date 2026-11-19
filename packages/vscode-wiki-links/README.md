# lat Wiki Links

This extension makes lat `[[wiki links]]` clickable in VS Code. It works in `@lat:` comments in source files and in Markdown files under `lat.md/`. A click opens the file and line the link points to.

## Requirements

The extension runs `lat resolve` to find each link target. You need a lat release that includes `lat resolve`. Check with:

```bash
lat resolve --help
```

The `lat` binary must be on your PATH, or the `latWikiLinks.latPath` setting must name it.

## Settings

- `latWikiLinks.latPath` is the path to the lat binary. The default is `lat`. Set it in User settings. It has machine scope, so VS Code ignores it in a workspace's `.vscode/settings.json`.

## Workspace trust

Clicking a link runs the lat binary. The extension therefore works only in a trusted workspace. Links stay inactive until you trust the workspace.

## Build and install

Run these commands from the root of the lat.md repository:

```bash
pnpm install
pnpm --filter vscode-wiki-links package
code --install-extension packages/vscode-wiki-links/vscode-wiki-links-0.0.1.vsix
```

You can also use Extensions: Install from VSIX in the command palette. The package command writes the `.vsix` file into this directory.

## Use a lat release without `lat resolve`

If your installed lat has no `resolve` command, point `latWikiLinks.latPath` at a wrapper script that runs the lat built from this repository. Save this as an executable file, for example `~/bin/lat-wrapper`. Replace `REPO` with the path to your checkout.

```sh
#!/bin/sh
exec node REPO/dist/src/cli/index.js "$@"
```

Then set `latWikiLinks.latPath` to the full path of the wrapper in your User settings.
