# lat.md conventions this project enforces

`lat check` fails on the first three rules below. The last two it cannot see,
and they matter as much. None of the five are style preferences. This block is
generated and a later `lat init` replaces it — record project guidance in
`lat.md/`, never here.

## Every document goes in a Diátaxis mode directory

A document belongs in exactly one of four subdirectories, and `lat check mode`
enforces one shape rule for each:

| Directory | Holds | Shape rule |
| --- | --- | --- |
| `lat.md/tutorials/` | a guided first pass for someone new | an ordered list of steps, and a stated outcome |
| `lat.md/how-to/` | a recipe for a task that recurs | an ordered list of steps |
| `lat.md/reference/` | lookup facts: fields, states, limits, names | no narrative prose — no second paragraph under a heading |
| `lat.md/explanation/` | why the design is what it is | no imperative commands |

Do not write documents at the top of `lat.md/`. The root index is the only file
that belongs there. When it carries `require-mode: true`, a document with no
declared mode and no mode directory is a `lat check` error.

**A document that fails its mode is usually two documents.** A file that lists
the states *and* argues for the design is mixed: the lookup half goes in
`reference/`, the reasoning half in `explanation/`, and each links the other.
Filing it under one mode and softening the prose until the check passes is the
wrong repair. So is leaving it at the top level where no check can see it.

Classify before writing, not after. If a `diataxis` skill is available, use it.

## Every project has at least one `@lat:` code ref

`lat check` fails a tree that has documents and no `@lat:` ref anywhere in the
codebase. A graph nothing points at cannot be reached from the code, which is
the only reason it exists.

Start at the application entrypoint — `config/application.rb`, `src/index.ts`,
`main.go`, `manage.py`, whatever a new reader opens first — and point it at the
root index:

```ruby
# @lat: [[lat#Acme]]
module Acme
```

Then one ref per section that source code actually implements, placed at that
code. Never in a block at the top of a file.

### An `@lat:` pointer is exempt from this project's comment conventions

A repository that minimises, budgets, or forbids comments is right about prose
comments and does not reach this one. An `@lat:` line is a machine directive,
in the same class as `# frozen_string_literal:` or `// eslint-disable`. It
carries no rationale, asserts nothing a reader could dispute, and cannot rot
quietly — `lat check` fails the moment its target moves or disappears.

Add the ref. Then, if the reasoning that would have been a comment is worth
keeping, put it in a `lat.md/explanation/` section and let the pointer reach it.

### The marker is a comment syntax, not a language allowlist

`//` for C-family languages; `#` for Ruby, Python, shell, Elixir, YAML, Make,
and everything else that comments with `#`. The scan is textual and walks every
non-markdown file in the project, so every language works.

Any list of example languages you find is a list of examples. Never conclude a
language is unsupported because it is absent from one. `lat check` prints what
it scanned:

```
Scanned 41 .md, 622 .rb, 118 .tsx in 1.2s
```

Read that line rather than guessing, and if you are still unsure, add one ref
and run the check. It costs one command.

(The tree-sitter grammars limit only `[[src/file.ts#symbol]]` wiki links, which
resolve a symbol inside source. `@lat:` refs point the other way and have no
such limit.)

## Test specs are wired to their tests

A document describing tests declares it in frontmatter:

```markdown
---
lat:
  require-code-mention: true
---
```

Every leaf section then needs exactly one `@lat:` comment at the test that
covers it, and every section needs at least one sentence saying what it
verifies and why. `lat check` reports any spec section no test claims, and any
ref pointing at no section.

## One specialty per document

A document is **small**, **discrete**, and does **not conflict** with any
other. Those are three demands on the same thing: a reader must be able to
find the one place a fact is written down, and trust it.

**Small — a document covers one specialty.** Not one topic area; one
specialty. When a document covers two, it is two documents. Past roughly forty
sections it has almost certainly become several, and an agent then loads all of
it to reach one part.

**Discrete — each document covers its own specialty.** Before writing a new
document, search for the specialty first:

```
lat search "the thing you are about to document"
```

An overlap has two honest repairs, and picking neither is what produces the
third copy. Either the two are one document and belong merged, or the part they
share is its own document that both link. Deciding they are "mostly different"
and writing anyway is how the set rots.

**Does not conflict — two documents never say different things about the same
specialty.** Never restate a fact another document owns. Link to it with
`[[section]]`. A restatement is a second copy, a second copy drifts, and drift
is how document B ends up contradicting document A while both look maintained.

The mode rule above is the sharpest available test of "one specialty": a
document that fails its mode is usually two documents. Split it. Do not soften
the prose until the check passes.

## Read sections, not files

`lat search` prints a section id and the exact lines that section occupies.
Resolve it with `lat section`, or read only that line range. Opening the whole
file is the reflex to break, and it is the expensive one:

```
lat search "how does backend selection work"
lat section "cli#CLI#search#Backend selection"
```

not a `read` of `lat.md/cli.md`. Measured on lat.md's own graph, the section
costs 4 KB against the file's 44 KB — eleven times the context for the same
answer, and the answer arrives buried in forty-one sections that were not
asked about.

Use `lat expand` on a prompt carrying `[[refs]]` for the same reason: it
resolves each ref to a location and a preview rather than to a file.
