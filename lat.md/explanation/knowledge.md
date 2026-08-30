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

## Session Markers

`lat hook` runs as a fresh process per prompt, so the two marker sets would start empty every time without on-disk persistence. `src/knowledge/session.ts` is that persistence, keyed on the hook payload's session id.

`attemptedEmpty` entries expire after [[src/knowledge/session.ts#ATTEMPTED_EMPTY_TTL_MS]] (5 minutes). The expiry is short and deliberately so: the set means "found nothing last time, worth another look", not "never look again". A missing or long expiry would let a document that caught the stores cold on the first prompt stay unreachable for the rest of the session — exactly the starvation the attempt budget exists to prevent.

Callers pass the same handle back to `saveSessionMarkers` so an id already in `attemptedEmpty` keeps its original recorded time, instead of having its TTL refreshed on every prompt.

### Marker path hardening

The marker path is a hash of the session id, and therefore predictable — another local user who can observe or predict the session id could plant a symlink there ahead of us.

The defence ports the `private_dir` pattern from the shell hooks this replaces: verify no symlink, create with mode `0700`, then re-verify ownership and mode *after* creation, because `mkdir -p` succeeds silently on a path that is already a symlink to a directory. Every open additionally passes `O_NOFOLLOW`, so a link planted in the window between the check and the read still cannot be followed.

Failing any of this must never fail the prompt and must never suppress a lookup. On any doubt about the path's safety the code drops back to fresh, empty sets: federation still runs, without cross-prompt memory for that call, rather than crashing or letting a hostile file decide whether federation fires at all.

## Output Format

Results are grouped by document, then by store, under a single header. Store groups are labelled `cq:`, `bd memories:`, and `Claude Code memory:`.

The [[untrusted-content#Notice]] appears exactly once, at the top of the whole result — never once per document. Everything below it is store content and is quoted accordingly.

Federation returns `null` rather than an empty string when nothing matched, so the hook can distinguish "no output to add" from "an empty block to add".

## Test Specs

Behaviour is specified in [[tests/knowledge-store]] and [[tests/knowledge-session]], with the federation entry point covered by the federate specs in [[tests/tests]].
