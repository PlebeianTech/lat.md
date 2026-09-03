<p align="center">
  <img src="templates/logo-dark.svg" alt="lat.md" width="500">
</p>

<p align="center">
  <a href="https://github.com/PlebeianTech/lat.md/actions/workflows/ci.yml"><img src="https://github.com/PlebeianTech/lat.md/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@plebeiantech/lat.md"><img src="https://img.shields.io/npm/v/@plebeiantech/lat.md" alt="npm"></a>
</p>

# Fork of https://github.com/vercel-labs/lat.md

<p align="center">A knowledge graph for your codebase, written in markdown.</p>

## The problem

`AGENTS.md` doesn't scale. A single flat file can describe a small project, but as a codebase grows, maintaining one monolithic document becomes impractical. Key design decisions get buried, business logic goes undocumented, and agents hallucinate context they should be able to look up.

## The idea

Compress the knowledge about your program domain into a **graph** — a set of interconnected markdown files that live in a `lat.md/` directory at the root of your project. Sections link to each other with `[[wiki links]]`, markdown files link into the codebase (`[[src/auth.ts#validateToken]]`), source files link back with `// @lat: [[section-id]]` comments, and `lat check` ensures nothing drifts out of sync.

- **Faster coding for agents** — instead of grepping through your codebase, agents search the knowledge graph to discover key design decisions, constraints, and domain context fast and consistently.

- **Faster workflow for humans** — your agents maintain lat files for you. When you review a diff, start with the semantic changes in `lat.md/` to understand *what* changed and *why*. Reviewing code becomes the secondary task.

- **Knowledge retention** — the context and reasoning behind your prompts is usually lost after a session ends. With lat, agents capture that knowledge into the graph as they work, so future sessions start with full context instead of rediscovering it from scratch.

- **Test specs with enforcement** — test cases can be described as sections in `lat.md/` and marked with `require-code-mention: true`. Each spec then must be referenced by a `// @lat:` comment in test code. `lat check` flags any spec without a backlink, so you can review and maintain test coverage from the knowledge graph.

The `lat` CLI gives agents and humans a system to navigate and maintain the graph:

- **`lat init`** — sets up popular coding agents with hooks and instructions to keep lat updated and correct
- **`lat check`** — enforces referential consistency; agents call it automatically before finishing work
- **`lat search`** and **`lat section`** — agents use these to understand your prompts and navigate the graph instead of endless `grep` calls

`lat` is a workflow that comes with tools — build pre-commit hooks and GitHub bots, run CI tasks that improve the knowledge graph in the background.

## Install

This is a fork. It publishes as [`@plebeiantech/lat.md`](https://www.npmjs.com/package/@plebeiantech/lat.md) and never under upstream's `lat.md` name, so the two can coexist.

With [mise](https://mise.jdx.dev/):

```bash
mise settings add minimum_release_age_excludes npm:@plebeiantech/lat.md
mise use -g npm:@plebeiantech/lat.md@latest
```

The first line is needed once per machine. mise quarantines any npm version published in the last day or so, and a fresh release is invisible until that window passes — the exclude waives it for this package alone and leaves the guard in force for every other tool.

With npm:

```bash
npm install -g @plebeiantech/lat.md
```

Or straight from a GitHub Release, which needs no registry and no authentication:

```bash
npm i -g --prefix ~/.local/lat https://github.com/PlebeianTech/lat.md/releases/latest/download/lat.md-latest.tgz
```

That last one wants `~/.local/lat/bin` on your `PATH`. A fixed prefix keeps the install independent of whichever Node version is active.

Pick one route and stay on it. A Release-route install left on `PATH` shadows a mise-managed one — `mise upgrade` then reports a new version while the shell keeps running the old binary.

Then run `lat init` in the repo you want to use lat in.

### As a Claude Code plugin

The hooks are also packaged as a plugin, installable straight from this repository:

```
/plugin marketplace add PlebeianTech/lat.md
/plugin install lat-md@lat-md
```

The plugin ships hooks only and finds `lat` on your `PATH`, accepting a build only if its version carries a `-fork` suffix.

### As an Antigravity / Gemini CLI plugin

The hooks, rules, and skills are packaged as an Antigravity plugin under `plugins/lat-md/`.

You can install it directly without cloning the repository:

**Global installation (all local projects):**
```bash
mkdir -p ~/.gemini/config/plugins/lat-md && \
curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
  tar -xz -C ~/.gemini/config/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
```

**Workspace installation (single repository):**
```bash
mkdir -p .agents/plugins/lat-md && \
curl -sL https://github.com/PlebeianTech/lat.md/archive/refs/heads/main.tar.gz | \
  tar -xz -C .agents/plugins/lat-md --strip-components=2 lat.md-main/plugins/lat-md
```

Alternatively, install `@plebeiantech/lat.md` via npm/mise, run `lat init` in your project, and select **Antigravity / Gemini** from the agent checklist.



## How it works

Run `lat init` to scaffold a `lat.md/` directory, then write markdown files describing your architecture, business logic, test specs — whatever matters. Link between sections using `[[file#Section#Subsection]]` syntax. Link to source code symbols with `[[src/auth.ts#validateToken]]`. Annotate source code with `// @lat: [[section-id]]` (or `# @lat: [[section-id]]` in Python) comments to tie implementation back to concepts.

```
my-project/
├── lat.md/
│   ├── architecture.md    # system design, key decisions
│   ├── auth.md            # authentication & authorization logic
│   └── tests.md           # test specs (require-code-mention: true)
├── src/
│   ├── auth.ts            # // @lat: [[auth#OAuth Flow]]
│   └── server.ts          # // @lat: [[architecture#Request Pipeline]]
└── ...
```

## CLI

```bash
lat init                        # scaffold a lat.md/ directory
lat check                       # run full graph and documentation validation
lat locate "OAuth Flow"         # find sections by name (exact, fuzzy)
lat section "auth#OAuth Flow"   # show a section with its links and refs
lat refs "auth#OAuth Flow"      # find what references a section
lat search "how do we auth?"    # semantic search via embeddings
lat expand "fix [[OAuth Flow]]" # expand [[refs]] in a prompt for agents
lat mcp                         # start MCP server for editor integration
```

## Configuration

Semantic search (`lat search`) works **offline by default** — no API key required. It uses a bundled local embedding model (all-MiniLM-L6-v2, compiled to WebAssembly; no native binaries, no network).

To use higher-quality hosted embeddings instead, provide an OpenAI (`sk-...`) or Vercel AI Gateway (`vck_...`) API key, resolved in order:

1. `LAT_LLM_KEY` env var — direct value
2. `LAT_LLM_KEY_FILE` env var — path to a file containing the key
3. `LAT_LLM_KEY_HELPER` env var — shell command that prints the key (10s timeout)
4. Config file — power users can set `llm_key` manually. Run `lat config` to print its location.

Switch backends any time with `lat reindex` (`--local` to force the offline model, `--remote` to use your key).

## Development

Development requires Node.js 22, pnpm, and Rust installed through rustup. The
pnpm setup installs the matching WASM target and build tools project-locally.
See the [development process](lat.md/dev-process.md) for complete setup and
contribution guidance.

```bash
pnpm install
pnpm buildall
pnpm test
```
