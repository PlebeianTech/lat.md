---
lat:
  mode: how-to
---
# Installing the Antigravity Plugin

Procedures for installing and activating the lat.md plugin in Google Antigravity and Gemini CLI environments.

1. **Choose an installation scope** — decide whether to install per-workspace (`.agents/plugins/`) or globally (`~/.gemini/config/plugins/`).
2. **Deploy the plugin files** — copy the `plugins/lat-md` directory to your chosen plugin directory.
3. **Verify plugin discovery** — launch Antigravity or inspect active plugins to confirm `lat-md` is discovered and enabled.
4. **Initialize repository documentation** — run `lat init` in target repositories and select `Antigravity / Gemini`.

## Workspace installation

Deploy the plugin directly into a single repository workspace.

1. Create the workspace plugin directory:
   ```bash
   mkdir -p .agents/plugins/lat-md
   ```
2. Download and extract the plugin bundle directly from the repository archive without cloning:
   ```bash
   curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
     tar -xz -C .agents/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
   ```
3. Verify the manifest exists at `.agents/plugins/lat-md/plugin.json`.

## Global user installation

Install the plugin once to enable lat.md capabilities across all local projects.

1. Create the global Antigravity plugins directory:
   ```bash
   mkdir -p ~/.gemini/config/plugins/lat-md
   ```
2. Download and extract the plugin bundle without cloning:
   ```bash
   curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
     tar -xz -C ~/.gemini/config/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
   ```
3. Install the `lat` CLI globally:
   ```bash
   npm install -g @plebeiantech/lat.md
   ```

## Initialization via CLI

Configure a workspace repository automatically without downloading plugin bundles manually.

1. Install the `lat` CLI globally or via mise:
   ```bash
   npm install -g @plebeiantech/lat.md
   ```
2. Run `lat init` in your project root:
   ```bash
   lat init
   ```
3. Select `Antigravity / Gemini` from the interactive agent checklist menu.
