# Use codebase-memory-mcp as a knowledge store

Register the codebase-memory-mcp (CBM) code graph as an external store, so
federation shows the code symbols that match a document's tags and lat can
look up who calls a code symbol. The protocol is in
[[knowledge-federation#External stores]] and
[[knowledge-federation#External stores#Callers]]. The adapter is
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
         "operations": ["query", "callers"],
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

   Ask for callers the same way:

   ```sh
   echo '{"operation":"callers","projectRoot":"/abs/path/to/project","symbols":[{"file":"src/knowledge/index.ts","name":"federateTags"}],"depth":1}' \
     | node /abs/path/to/dist/src/fork/adapters/codebase-memory-store.js
   ```

   It prints `[{"symbol":{...},"callers":[{"file","name","line"}]}]`.

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

## How callers are found

For one `callers` request the adapter runs `cli list_projects` once, then
three CBM calls in turn for each symbol.

It answers only the first four symbols of a request
([[src/fork/adapters/codebase-memory-store.ts#MAX_SYMBOLS_PER_REQUEST]]) and
ignores the rest. lat sends symbols in the order it finds them, such as the
order of links in a document, so earlier symbols win. The adapter looks up
the four at once and answers in request order. A CBM call that fails drops
only its own symbol. The three calls, each with `--format json`, are:

- `search_graph --project NAME --name-pattern ^NAME$ --file-pattern FILE`
  finds the symbol. The name is the part after the last `#` of the lat name.
  The adapter keeps only rows whose file is exactly `FILE` and whose name
  equals the name in the same case: CBM matches the pattern without regard
  to case and `--file-pattern` also matches any file that contains `FILE`.
  A symbol with no such row is left out of the answer.
- `trace_path --project NAME --function-name QN --direction inbound --depth
  N` lists the callers. `QN` is the qualified name from the first call.
- `search_graph --project NAME --qn-pattern ^(QN1|QN2)$ --limit COUNT` finds
  the file and line of all callers at once.

What running the real CLI (CBM 0.12.1) showed:

- **Flags.** `trace_path` takes `--function-name`, `--project`, `--direction`
  (`inbound`, `outbound` or `both`, default `both`), `--depth` (default 3),
  `--limit` (default 100), `--include-tests` (default `false`) and `--mode`
  (default `calls`). The adapter sets only direction and depth.
- **Output.** `trace_path --format json` prints `{"function","direction",
  "callers_total","callers":{"cols":["name","hop"],"groups":[{"qn_prefix",
  "rows":[["handleUserPromptSubmit",1]]}]}}`. It gives no file and no line,
  and the qualified name is `qn_prefix`, a dot, then the name. This is why
  the third call is needed.
- **Depth.** `--depth N` returns the callers of every hop up to N in one
  list, nearest first, with the hop in each row. `--depth 0` returns none.
  `--depth 20` is accepted although the README says 15.
- **Tests.** Callers in test files are left out unless `--include-tests
  true`. The adapter does not pass it, so a function that only tests call
  has no callers.
- **Same name.** `--function-name greet` with several matches prints
  `{"status":"ambiguous","suggestions":[...]}` and no `callers`. A qualified
  name is exact, so the adapter always passes one. In a Ruby file with a
  top-level `greet` and `Greeter#greet`, the qualified names differ by the
  class: `PROJECT.src.greeter.greet` and `PROJECT.src.greeter.Greeter.greet`.
  A lat name `Greeter#greet` matches the row whose `qn_prefix` ends in
  `.Greeter`. A bare name matches the row with the shortest `qn_prefix`.
- **Errors.** A function that is not found, or a project that is not
  indexed, makes CBM print `{"error":...}` and exit 1. A function without
  callers exits 0 with `"groups":[]`.
- **Caller names.** A caller that is a `Method` is named `Class#method`, with
  the class taken from the last part of its `qn_prefix`. Any other caller is
  named by its bare name.

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

A `callers` request makes one `list_projects` call, then up to three calls
for each symbol that CBM finds and one for each that it does not. The four
answered symbols run at once, so four symbols take about as long as one.
Measured against the main lat.md checkout with `daemon start` running: one,
three (two found, one unknown) and four symbols each took 1.8 to 1.9 s. With
no daemon, one symbol took 7.4 s and three symbols took 8.5 s. With the
daemon, a `callers` request fits in `timeout_ms: 3000`.

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

## Callers check

`findCallers` returned real callers when the store was registered in a
temporary config.

Done by hand with `XDG_CONFIG_HOME` set to a temporary directory that holds
`lat/config.json` with the entry from step 6, `"operations": ["query",
"callers"]`, `timeout_ms` 8000 and the daemon running. The project was the
main lat.md checkout. `findCallers` with `depth` 2 for `federateTags` in
`src/knowledge/index.ts` and for `noSuchFunction` took 2.3 s. It returned
callers for the first symbol only:

```
src/knowledge/index.ts#federateTags:
  src/cli/hook.ts:153 handleUserPromptSubmit
  src/fork/antigravity-hook.ts:196 handleAntigravityPreInvocation
  src/cli/hook.ts:618 hookCmd
  src/fork/antigravity-hook.ts:545 handleAntigravityHook
```

The first two are direct callers and the last two call those. `Sum#add` in
`src/fork/usage/aggregate-types.ts` returned its two callers,
`computeTotals` and `estimateSavings`. `CheckRunContext#allSections` returned
no callers although `search_graph` shows 19 incoming edges for it: `trace_path`
follows call edges only.

## Limits

The adapter has these limits.

- CBM emits no call edge when it cannot type a receiver. Dynamic Ruby code
  has many such calls, so a Ruby project yields fewer results than a typed
  language does.
- The adapter answers `query` and `callers`. For `callers`, CBM follows call
  edges that it can resolve statically. It misses dynamic dispatch such as
  Ruby's `send` and `method_missing`, and calls through a receiver it cannot
  type. A symbol with no callers and a symbol whose callers CBM missed look
  the same: `"callers":[]`.
- Callers in test files are not returned.
- A `callers` request answers only its first four symbols.
- A method that is a caller is named `Class#method` from its qualified name.
  A language whose qualified names do not hold the class, such as Go, gets a
  wrong prefix.
- A bare lat name matches a method of that name when the file has no
  top-level symbol of that name.
- A search matches names, not file text, so a tag with spaces matches
  nothing.
