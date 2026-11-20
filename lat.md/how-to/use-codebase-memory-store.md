# Use codebase-memory-mcp as a knowledge store

Register the codebase-memory-mcp (CBM) code graph as an external store, so
federation shows the code symbols that match a document's tags. The protocol
is in [[knowledge-federation#External stores]]. The adapter is
[[src/fork/adapters/codebase-memory-store.ts]]; its tests are in
[[fork-codebase-memory-store]].

1. **Install CBM.** Use the install script, or the npm, PyPI or Homebrew
   package from the CBM README, and check `codebase-memory-mcp --version`.
   Do not run `codebase-memory-mcp install` unless you want it to rewrite
   your agent configurations: the adapter needs only the binary on `PATH`.
2. **Index the project.** Run
   `codebase-memory-mcp cli index_repository --repo-path /abs/path/to/project`.
   CBM excludes `.claude/`, so a Claude Code worktree under it is not
   indexed. The index is a snapshot: run the command again after large
   changes.
3. **Check the project name.** Run
   `codebase-memory-mcp cli list_projects --format json`. It prints
   `{"projects":[{"name":"...","root_path":"/abs/path","branch":"main"}],...}`.
   The adapter picks the project whose `root_path` equals the request's
   `projectRoot`.
4. **Keep a daemon running.** Run `codebase-memory-mcp daemon start`. Without
   it, every CBM call starts a temporary daemon and the adapter is too slow
   (see Measured cost). Stop it with `codebase-memory-mcp daemon stop`.
5. **Build lat** with `pnpm build`. The adapter compiles to
   `dist/src/fork/adapters/codebase-memory-store.js` in the lat package.
6. **Register the store.** Find the file with `lat paths --config` and add
   an entry to its `knowledge_stores` array. The command is `node` and the
   absolute path of the compiled adapter:

   ```json
   {
     "knowledge_stores": [
       {
         "name": "codebase-memory",
         "label": "Code graph",
         "command": ["node", "/abs/path/to/dist/src/fork/adapters/codebase-memory-store.js"],
         "timeout_ms": 3000
       }
     ]
   }
   ```

7. **Try it.** Pipe a request to the adapter:

   ```sh
   echo '{"operation":"query","terms":["federate"],"projectRoot":"/abs/path/to/project","limit":3}' \
     | node /abs/path/to/dist/src/fork/adapters/codebase-memory-store.js
   ```

   It prints a JSON array of `{key,title,detail,score}`. `key` and `title`
   are the CBM qualified name, `detail` is `file:line`, and `score` is the
   number of terms that matched the symbol.

## What the adapter runs

For one `query` request the adapter runs `codebase-memory-mcp` through
`execFile`, with no shell, in this order:

- `cli list_projects --format json` once, to find the project.
- `cli search_graph --project NAME --name-pattern REGEX --format json` once
  per term. The term is regex-escaped, so `a.b*` becomes `a\.b\*`. CBM
  matches the pattern anywhere in the name and ignores case.

`search_graph` prints groups of rows, not one list:

```json
{"cols":["name","label","lines","in","out"],
 "groups":[{"qn_prefix":"PROJECT.src.knowledge","file":"src/knowledge/index.ts",
            "rows":[["FederateOptions","Type","62-92",1,0]]}],
 "total":14,"returned":1,"has_more":true}
```

The qualified name is `qn_prefix`, a dot, then `name`. `lines` is
`"start-end"`, or empty for a file node; the hit uses the start line.
`cli --json` wraps the same payload in an MCP envelope, which the adapter
does not use. A project that is not indexed makes CBM print an error and
exit 1, and an invalid regex also exits 1. Any failure makes the adapter
print `[]` and exit 0.

## Measured cost

Measured on macOS with CBM 0.12.1, against a project of about 1,000
symbols. Without a daemon the adapter is too slow for the default timeout.

Each CBM call is one process. The CLI starts a temporary daemon when none
runs, and that daemon did not keep the adapter's output pipe open: `execFile`
returned as soon as the CLI exited, so nothing waited for a timeout.

- **No daemon running:** 1.0 s for a single CLI call. Inside the adapter the
  calls interact with the previous call's daemon, which is still exiting,
  and a call can take 2 s. An adapter run took 2.1 to 3.2 s with one term,
  about 5.2 s with two terms and 5.2 to 7.2 s with three.
- **`daemon start` running:** 0.52 s for a single CLI call. An adapter run
  took 1.1 s with one term, 1.6 s with two and 2.1 s with three. Four runs
  at once took the same time as one (1.4 s for two terms).

The default `timeout_ms` of 2000 is too short in both cases. Federation
passes at most two terms ([[src/knowledge/index.ts#federateTags]]), so a run
is three CBM calls. With the daemon, 1.6 s fits in `timeout_ms: 3000`.
Without it, federation with `timeout_ms: 3000` printed nothing, and with
`timeout_ms: 4900` it returned hits in two of three tries, after 4.2 to
4.9 s, close to the 5 s federation deadline.

Federation can run the adapter for up to 20 documents per prompt, four at a
time, under that 5 s deadline. With the daemon, a wave of four runs takes
about 1.5 s, so about three waves (12 documents) fit before the deadline and
the rest are not tried. Without the daemon, almost no run finishes.

## Federation check

Federation printed the adapter's hits when the store was registered in a
temporary config.

Done by hand with `XDG_CONFIG_HOME` set to a temporary directory that holds
`lat/config.json` with the entry from step 6, `timeout_ms` 3000, and the
daemon running. `federateTags` for two documents, tagged `federate, external`
and `callers`, took 1.4 s and printed the hits under the label `Code graph:`:

```
doc-one (federate, external):
Code graph:
- "PROJECT.src.knowledge.FederateOptions" -> "src/knowledge/index.ts:62"
```

`lat paths --config` honours `XDG_CONFIG_HOME` on macOS, so the real config is
untouched.

## Limits

The adapter has these limits.

- CBM emits no call edge when it cannot type a receiver. Dynamic Ruby code
  has many such calls, so a Ruby project yields fewer results than a typed
  language does.
- The adapter answers `query` only.
- A search matches names, not file text, so a tag with spaces matches
  nothing.
