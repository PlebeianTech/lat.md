# Antigravity & Gemini CLI Plugin for lat.md

This plugin integrates [lat.md](https://github.com/PlebeianTech/lat.md) with Google Antigravity and Gemini CLI. It grounds the agent in your codebase knowledge graph, prevents multi-line rationale comments in source code, maintains directory indexes, and blocks finishing work on check failures.

## Features

- **PreInvocation Hook**: Automatically expands wiki links (`[[section]]`) in user prompts, retrieves relevant sections using semantic search, and reminds the agent to maintain the knowledge graph.
- **PreToolUse Hook**: Intercepts file edits (`replace_file_content` and `write_to_file`) and blocks multi-line rationale comments, prompting the agent to document the reasoning in `lat.md/` with a `@lat:` pointer instead.
- **PostToolUse Hook**: Runs index synchronization after file modifications.
- **Stop Hook**: Enforces `lat check` (including Diátaxis mode validation) before the agent completes its work, refusing stop if errors remain.
- **Bundled Skills**: Provides `lat-md` (syntax & structure authoring guide) and `lat-md-conventions` (fork conventions & rules).
- **Rules**: Injects core `lat.md` workflow directives via `rules/AGENTS.md`.

## Installation

### Option 1: Via `lat init` (Zero Clone, Recommended)

You do not need to clone the repository to use lat.md with Antigravity. Install the CLI and initialize your repository directly:

```bash
npm install -g @plebeiantech/lat.md
# or: mise use -g npm:@plebeiantech/lat.md@latest

lat init
```

Select **Antigravity / Gemini** from the agent checklist menu. This automatically writes `.agents/hooks.json`, `GEMINI.md`, and `.agents/skills/`.

### Option 2: Global User Plugin (Without Cloning)

To install the plugin bundle globally across all repositories without cloning:

```bash
mkdir -p ~/.gemini/config/plugins/lat-md && \
curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
  tar -xz -C ~/.gemini/config/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
```

### Option 3: Workspace Plugin (Without Cloning)

To install the plugin bundle into a specific repository without cloning:

```bash
mkdir -p .agents/plugins/lat-md && \
curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
  tar -xz -C .agents/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
```

## Requirements

The plugin requires the `@plebeiantech/lat.md` CLI on your `PATH`:

```bash
npm install -g @plebeiantech/lat.md
```

Or using [mise](https://mise.jdx.dev/):

```bash
mise use -g npm:@plebeiantech/lat.md@latest
```
