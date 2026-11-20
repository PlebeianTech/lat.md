# Knowledge Federation

Looks up related knowledge from external stores when a tagged section is surfaced to an agent, and folds the results into the [[cli#hook#UserPromptSubmit]] payload. Driven by the [[markdown#Frontmatter#tags]] field. Entry point: [[src/knowledge/index.ts#federateTags]].

The subsystem exists because the knowledge an agent needs is rarely all in one place: some lives in this repository's `lat.md/`, some in a team knowledge base, some in project memory written during an earlier session. A tagged section names the subject; federation goes and asks everyone else what they know about it.

## Store Contract

Every store implements the same two-method shape defined in `src/knowledge/types.ts` — a `name` and a `query` returning ranked hits. The contract is deliberately the one file in `src/knowledge/` that no individual store owns.

The governing rule is that **a store is optional**. Absent binary, absent database, absent directory, malformed row, non-zero exit, timeout — every one of those resolves to an empty result. A store must never throw and must never write to stdout or stderr.

This is not defensive habit; it is the only behaviour that makes federation safe to put on the prompt path. `lat hook` must not fail a user's prompt because a lookup that was never guaranteed to find anything found nothing.

[[src/knowledge/index.ts#DEFAULT_STORES]] loads the three built-ins with a dynamic `import()` wrapped per store, so one missing or broken store module leaves the other two available.

### Hit shape

A `KnowledgeHit` carries `store`, `key`, `title`, `detail`, and `score`. Text is raw at this layer — quoting is the caller's job, handled by [[untrusted-content]].

`key` is a stable identity used for dedupe and match counting, never shown to a reader. `score` is the number of query terms that matched; a store that ranks internally reports the number of terms it was given.

## Stores

Three built-in stores, each wrapping a tool that may or may not be installed. All three are queried concurrently per document via `Promise.allSettled`.

Concurrency is the reason every store uses async `execFile` rather than `execFileSync`. A synchronous subprocess call would block the event loop and prevent the other stores' I/O from overlapping with it, collapsing the fan-out back into serial calls.

### cq

Queries the cq shared knowledge commons, a local SQLite database read directly through `@libsql/client`. Located via `CQ_LOCAL_DB_PATH`, falling back to the XDG data directory. Implementation: `src/knowledge/cq.ts`.

Terms are filtered through a strict `SAFE_TERM` pattern — Unicode letters, digits, and internal hyphens only — before being interpolated into an FTS5 `MATCH` string. Terms originate in repository frontmatter, which is attacker-controlled the moment an agent runs `lat` in a repository nobody here owns, and a term containing a double quote would break out of the quoted match expression.

Unicode letters and digits are allowed rather than ASCII alone, so a tag written in a non-Latin script still reaches the store. FTS5's tokenizer handles them, and they carry none of the syntactic meaning that quotes or parens do.

Using a client that returns structured rows, rather than shelling out to the `sqlite3` CLI, removes a class of parsing bugs by construction: the CLI's one-row-per-line list output needs newlines flattened and a control character as column separator to survive a summary that itself contains a newline or a pipe.

### bd

Shells out to `bd memories --json <term>`, once per term. Implementation: `src/knowledge/bd.ts`. Calls are capped by a 2-second per-call timeout.

Invoked in argv form with no shell, for the same reason cq filters its terms: frontmatter is attacker-controlled, so a term must never be interpretable as shell syntax.

`stdin: 'ignore'` is load-bearing rather than cosmetic. The shell implementation this replaced ran its per-term loop inside a `while read` on stdin, and an external tool inside that loop that itself read stdin would silently consume the remaining terms. The symptom was that some documents simply never appeared — indistinguishable from a genuine miss.

### claude-memory

Reads Claude Code's per-repository memory files, matching terms at word boundaries. Implementation: `src/knowledge/claude-memory.ts`. Files are capped at 64 KB.

Claude Code keys its memory store on the **main** checkout's absolute path; a git worktree has no store of its own. The store therefore resolves `projectRoot` through `git rev-parse --git-common-dir` and takes its parent before looking anything up.

Without that resolution, every lookup made from inside a worktree session silently finds nothing — a failure invisible unless you know to check, because it never errors, it just never matches. Outside a git repository, or on any failure, it falls back to `projectRoot` itself.

#### Frontmatter is read as a block, not as a pattern

A hit's `title` and `detail` come from the `name:` and `description:` lines of the leading `---` block only. The block is sliced off first; the body is never searched for them.

Matching the key pattern against the whole file instead lets a memory file's *body* decide what gets federated into an agent's prompt — a line beginning `description:` inside a fenced code block or a quoted example is indistinguishable from the real field, and the first such line anywhere in 64 KB wins. The body is content, not metadata, and content that reaches a prompt is [[untrusted-content|untrusted]].

A file with no frontmatter block therefore has no `name` and no `description`, and falls back to its basename with an empty detail.

#### The 64 KB cap falls on a character boundary

The cap trims back to the last complete UTF-8 sequence rather than cutting mid-character, so a file that crosses 64 KB never ends in U+FFFD.

## External stores

A user can add a store without a new module in lat: they register a command
under `knowledge_stores` in their own lat config. Implementation:
[[src/knowledge/external.ts]]. [[src/knowledge/index.ts#DEFAULT_STORES]]
appends one store per entry whose `operations` include `query`, after the
built-ins and in config order.

### Config format

The config is the user-level `config.json` from `lat paths --config`. Each
entry in the `knowledge_stores` array has these fields:

- `name`: letters, digits and hyphens. An entry named `cq`, `bd` or
  `claude-memory`, or named like an earlier entry, is skipped.
- `label`: the group label in federation output, followed by a colon. It is
  cleaned like any other untrusted id.
- `command`: an array of strings, the executable and then its arguments.
- `operations`: optional, default `["query"]`.
- `timeout_ms`: optional, default 2000.

```json
{
  "knowledge_stores": [
    {
      "name": "my-store",
      "label": "My store",
      "command": ["/usr/local/bin/my-store-adapter", "--json"],
      "timeout_ms": 1500
    }
  ]
}
```

[[src/knowledge/external.ts#readExternalStoreConfigs]] reads the file
itself and returns an empty list on any problem. It does not call
`readConfig`, which exits the process on a parse error: this code runs inside
a prompt hook. A malformed entry is skipped and the others stay.

### Request and response

lat runs `command[0]` with the other strings as arguments, through
`execFile` with no shell. It writes one JSON object to stdin:

```json
{"operation":"query","terms":["alpha"],"projectRoot":"/abs/path","limit":3}
```

The store prints a JSON array on stdout. Each object has a string `key`,
`title` and `detail` and a number `score`, with the same meaning as in
[[knowledge-federation#Store Contract#Hit shape]]. lat drops any object with
the wrong shape and keeps at most `limit` hits.

A non-zero exit, a timeout, output that is not a JSON array, or any other
error gives no hits from that store. The other stores are not affected.

lat kills the child at the smaller of `timeout_ms` and the time left before
the federation deadline. Without that, a child that federation had abandoned
would keep the hook process alive until its own timeout.

### Only the user config can register a store

lat reads stores only from the user's config, never from a file in the
repository. A command that a repository declared would run arbitrary code.

Repository content is attacker-controlled, as the cq term filter above
explains. The terms on stdin also come from repository frontmatter, so they
are passed as JSON data and never through a shell.

The test suite points `XDG_CONFIG_HOME` at an empty temporary directory, so it
never runs the stores that a developer registered.

### Callers

A store whose `operations` include `callers` answers who calls a code symbol.
[[src/knowledge/callers.ts#findCallers]] uses the first such store in config
order and reuses the config reader and process runner of
[[src/knowledge/external.ts]]. lat writes one JSON object to stdin:

```json
{"operation":"callers","projectRoot":"/abs/path","symbols":[{"file":"src/auth.rb","name":"User#login"}],"depth":1}
```

`file` is project-relative with forward slashes. `name` is the symbol path
that lat writes after the `#` in a source link, such as `App#listen` in
`[[src/server.ts#App#listen]]`.

The store prints a JSON array on stdout. Each object has the `symbol` that
was asked about and its `callers`, each with a string `file`, a string `name`
and a number `line`:

```json
[{"symbol":{"file":"src/auth.rb","name":"User#login"},"callers":[{"file":"src/app.rb","name":"App#run","line":7}]}]
```

The function returns a Map from `file#name` to that symbol's callers. With no
store that supports `callers`, a non-zero exit, a timeout or output that is
not JSON, the Map is empty. It skips a wrongly shaped entry or caller, and
drops any caller whose file is absolute or contains `..`.

## Term Selection

Turns a document's authored `tags:` into the search terms handed to each store. Implementation: [[src/knowledge/ranking.ts#tagsToTerms]]. The default budget is two terms.

Two terms is the least that still lets matched-term-count ranking mean anything — a hit matching both terms outranks one matching a single term — while each additional term costs a subprocess or a query per store.

### One term per tag, then cap

A representative word is taken from each tag *before* the two-term cap is applied, rather than flattening every tag into words and capping that list.

A single hyphenated tag splits into several words. Capping the flattened list would let one tag exhaust the whole budget and starve every other tag the author wrote. Choosing one word per tag first means the cap trims across tags instead of within one.

Words shorter than three characters are dropped, and terms are deduplicated case-insensitively.

### Authored order is never sorted

Tag order is the author's own ranking of the terms and must survive to the point where the list is sliced to `maxTerms`.

The shell implementation this replaced piped terms through `sort -u` for the dedupe, and the sort silently reordered them too — so cutting to two terms took the two alphabetically-first fragments instead of the two the author actually wrote first. `tags: [run-pin, carry, query-param]` searched "carry" and "param", dropping the primary tag entirely.

## Attempt Budget

Federation is bounded by two independent counters — how many documents produced output (`maxEmitted`, default 3) and how many were actually queried (`maxAttempts`, default 20). The loop stops on those and on nothing else.

The distinction between the two counters is what keeps federation from starving documents at the end of a long list. Skips are free: a document that is already seen, already known-empty, or carries no usable tags is passed over **without spending an attempt**, so the attempt window slides further down the list on each successive prompt.

Tags from two documents are never pooled. Each document is queried with only its own terms, because two unrelated subjects intersect at nothing and pooling would produce noise attributed to the wrong document.

### seen and attemptedEmpty

Two marker sets separate "already reported" from "looked and found nothing", and they are treated differently on purpose.

A document that produced hits goes into `seen` and is never queried again. A document that produced nothing goes into `attemptedEmpty` instead — it is *not* marked seen, so a later run can still surface it once a store has something to say.

## Hit Budget

One prompt shows at most `maxTotalHits` hits across all documents and stores (default 9). Without it, each store added to federation could add up to nine more hits per prompt.

The cap is spent in the acceptance step: documents in document order, and within a document, stores in store order (built-ins first, then external stores in config order). Each store's hits are first limited to `perStoreLimit`, then cut when the cap runs out.

A document left with no hits is treated like a candidate beyond `maxEmitted`: it is not emitted and not added to `seen`, so a later prompt can still surface it. Below the cap, output is unchanged.

## Session Markers

`lat hook` runs as a fresh process per prompt, so the two marker sets would start empty every time without on-disk persistence. `src/knowledge/session.ts` is that persistence, keyed on the hook payload's session id.

`attemptedEmpty` entries expire after [[src/knowledge/session.ts#ATTEMPTED_EMPTY_TTL_MS]] (5 minutes). The expiry is short and deliberately so: the set means "found nothing last time, worth another look", not "never look again". A missing or long expiry would let a document that caught the stores cold on the first prompt stay unreachable for the rest of the session — exactly the starvation the attempt budget exists to prevent.

Callers pass the same handle back to `saveSessionMarkers` so an id already in `attemptedEmpty` keeps its original recorded time, instead of having its TTL refreshed on every prompt.

### Marker path hardening

The marker path is a hash of the session id, and therefore predictable — another local user who can observe or predict the session id could plant a symlink there ahead of us.

The defence ports the `private_dir` pattern from the shell hooks this replaces: verify no symlink, create with mode `0700`, then re-verify ownership and mode *after* creation, because `mkdir -p` succeeds silently on a path that is already a symlink to a directory. Every open additionally passes `O_NOFOLLOW`, so a link planted in the window between the check and the read still cannot be followed.

Failing any of this must never fail the prompt and must never suppress a lookup. On any doubt about the path's safety the code drops back to fresh, empty sets: federation still runs, without cross-prompt memory for that call, rather than crashing or letting a hostile file decide whether federation fires at all.

## Output Format

Results are grouped by document, then by store, under a single header. Store groups are labelled `cq:`, `bd memories:`, and `Claude Code memory:`. An external store's group uses its configured label.

The [[untrusted-content#Notice]] appears exactly once, at the top of the whole result — never once per document. Everything below it is store content and is quoted accordingly.

Federation returns `null` rather than an empty string when nothing matched, so the hook can distinguish "no output to add" from "an empty block to add".

### Callers in output

Under each emitted document, federation adds a `Callers (LABEL):` group that
lists who calls the code symbols the document links. `LABEL` is the label of
the callers store, cleaned like an external store label.

Only documents that already have store hits are emitted, so a document with
callers but no store hits is not shown. With no store that supports
`callers`, the output has no such group and is the same as without it.

[[src/knowledge/linked-symbols.ts#linkedSymbols]] reads the document's wiki
links and keeps those whose target is a source file path with a `#` symbol,
such as `[[src/auth.ts#validateToken]]`. It does not parse source files. It
takes at most 10 symbols per document, in link order.

Federation calls [[src/knowledge/callers.ts#findCallers]] once per call, at
depth 1, for the symbols of all emitted documents, inside the federation
deadline. A lookup that fails or outlasts the deadline gives no group and
leaves the store groups unchanged.

Each document lists at most 3 callers as `NAME (FILE:LINE)`, quoted like hit
text. Caller lines count against `maxTotalHits`, but they spend only what the
store hits leave of it, so the cap cuts caller lines first. When store hits use
the whole cap, the callers store is not run.

## Usage Events

When usage tracking is on for the project root (see
[[usage-analytics#Usage Analytics#Opt-in and the usage directory]]),
federation writes one usage event per store query. The command is
`federate:` plus the store name, so the cost and yield of each store can be
measured before more stores are added.

Each event has surface `hook` and caller `hook-injected`. It carries the
query's wall time as `duration_ms`, the joined terms as `query`, the
document id as `section_id`, and the hit count as `result_count` and
`found`. `session_id` is null and `not_captured`: federation does not
receive the session id. `injected_bytes` is null because the event injects
nothing itself; the `lat hook` event records the injection.

A query that the deadline abandons writes one event at the deadline, with
`error_class` `deadline`. The query keeps running, but when it settles it
writes nothing more, so each query has exactly one event.

Writing an event never throws out of federation and never changes its
output. With tracking off, nothing is written.

Aggregation skips `federate:` events when it counts injections, savings
and missed knowledge. Otherwise each store query would count as an
injection with uncaptured bytes, as a read of the document, and as an
unjoinable event, on top of the hook event that really injected the text.

## Test Specs

Behaviour is specified in [[tests/knowledge-store]] and [[tests/knowledge-session]], with the federation entry point covered by the federate specs in [[tests/tests]]. Usage events are specified in [[tests/fork-federate-usage]]. External stores are specified in
[[tests/fork-external-stores]] and their callers lookup in
[[tests/fork-external-callers]]. Callers in output are specified in
[[tests/fork-federate-callers]].
