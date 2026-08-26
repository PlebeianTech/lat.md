---
lat:
  require-code-mention: true
---
# Knowledge Store Additional Coverage

Additional coverage for the `Store` implementations under [[src/knowledge/index.ts]] added after their original tests were written: per-store concurrency (lat-t1y.22), locale/encoding edge cases, and federation hardening against hostile tag/id content.

Tests in `tests/knowledge/bd.test.ts`, `tests/knowledge/cq.test.ts`, `tests/knowledge/claude-memory.test.ts`, `tests/knowledge/ranking.test.ts`, `tests/knowledge/federate.test.ts`.

## bd store concurrency

lat-t1y.22 moved `bd.ts` from `spawnSync` to async `execFile` specifically so per-term subprocess calls can overlap instead of serializing on the event loop.

### Answers three terms well under the time three serial calls would take

Querying three terms against a `bd` fixture that sleeps before responding completes in well under 3x a single call's measured cost, proving the per-term calls run concurrently rather than serially.

### Abandons a call that exceeds the per-call timeout

A `bd` fixture that sleeps past `CALL_TIMEOUT_MS` is abandoned rather than awaited — the query resolves to no hits well within a bounded margin over the timeout, not the fixture's full delay.

## cq store lookup and encoding

Additional `cqStore` lookup and text-matching coverage.

### Finds a db under XDG_DATA_HOME when CQ_LOCAL_DB_PATH is unset

With `CQ_LOCAL_DB_PATH` unset, `cqStore` finds a database placed at the XDG-derived default path under `XDG_DATA_HOME`.

### Keeps a non-ASCII term instead of dropping it

A query term containing a non-ASCII letter (e.g. `café`) still matches a summary containing the same word.

## claude-memory store: slugify and memoization

Additional `claudeMemoryStore` coverage for non-ASCII matching and per-process memoization.

### Matches a non-ASCII term at a word boundary

A memory file's body containing a non-ASCII word (`café`) matches a query for that same term at a word boundary.

### Spawns git and reads each file only once per process

Two `claudeMemoryStore.query()` calls in the same process against the same project root perform git and file-read work only on the first call — the second call reuses the memoized result rather than re-spawning git or re-reading memory files.

## tagsToTerms: term budget per tag

`tagsToTerms` takes one term per tag before applying the `maxTerms` cap, so a single hyphenated tag can no longer consume the whole term budget and starve every tag after it.

### Reaches more than one authored tag with a hyphenated first tag

Given `['run-pin', 'carry', 'query-param']`, the result includes terms from more than one tag rather than exhausting the cap on the first tag's own hyphen-split words.

### Takes only the first qualifying word of a hyphenated tag

Given a single hyphenated tag with a generous `maxTerms`, only its first word ≥3 characters is taken, not every word in the tag.

### Keeps a non-ASCII tag instead of dropping it

A hyphenated tag whose first word contains a non-ASCII letter (`café-pin`) still yields that word as a term.

## federateTags: hostile tag and id content

Tag values and document ids come from repository frontmatter, which is attacker-controlled wherever `lat` runs in a repo nobody here owns. Federation output quotes them through [[src/untrusted.ts]] rather than trusting them verbatim.

### Emits a tag containing a newline on one line

A tag whose text contains an embedded newline (attempting to inject a fake instruction on its own line) is rendered on a single line in the federation summary.

### Strips control characters from a tag

A tag containing an ANSI escape sequence has the control characters stripped from the federation summary.

### Strips control characters from the document id

A document id containing a control character has it stripped from the federation summary, while the rest of the id is preserved.

## federateTags: cross-store concurrency and fault isolation

lat-t1y.22's move off synchronous subprocess calls in `bd.ts` and `claude-memory.ts` gives `federateTags`'s own `Promise.allSettled` fan-out real concurrency to exploit; these tests exercise that fan-out directly against fake stores.

### A rejecting store leaves the other stores' results intact

If one store's `query()` throws, the other stores' hits still appear in the federation result.

### Runs all stores concurrently

Three stores that each take about 200ms finish in about 200ms total, not the ~600ms serial execution would take.

## federateTags: attempt budget does not starve documents behind zero-yield ones

Regression for lat-t1y.15: a document that returns no hits still spent an attempt, so enough zero-yield documents ahead of an answerable one made it permanently unreachable.

The fix records a short-lived "attempted, found nothing" mark, distinct from `seen`, so a repeat call skips already-tried zero-yield documents for free.

### Reaches an answerable document on a later call once zero-yield documents ahead of it are marked

With more zero-yield documents ahead of an answerable one than the attempt budget allows, the first call reaches only zero-yield documents; a second call with shared state skips them for free and reaches the answerable one.

The zero-yield documents are never marked `seen` in the process — only `attemptedEmpty`, which expires, distinguishing "found nothing yet" from "already surfaced."

## federateTags: the deadline is hard, not advisory

`federateTags` runs on every prompt, so its overall deadline has to bound total wall clock rather than just dispatch. `bd` and `claude-memory` cap their own subprocess calls, but `cq`'s libsql `execute` carries no timeout of its own.

### Abandons a store that outlives the deadline

A store whose query never resolves does not hold the call open — the queries are raced against the remaining budget, so federation returns what it has instead of waiting.

### Leaves an unanswered document retryable

A document abandoned when the deadline expired is not marked `attemptedEmpty`, because it was never answered — a later call must still be free to try it.

