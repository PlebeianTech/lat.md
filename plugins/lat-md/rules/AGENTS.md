# Before starting work

Use Lat's knowledge graph to ground each task before changing code.

- Run `lat search` to find sections relevant to your task. Read them to understand the design intent before writing code.

# Post-task checklist (REQUIRED — do not skip)

After EVERY task, before responding to the user:

- [ ] Update `lat.md/` if you added or changed meaningful implemented functionality, architecture, tests, or behavior. Keep it a focused snapshot of the current implemented state, not a journal/changelog. Plans may be drafted in `lat.md/` alongside implementation, with the intent that by commit time they describe what was implemented. Otherwise, keep proposals, hypothetical designs, and future work outside `lat.md/` unless the user explicitly requests them there.
- [ ] Run `lat check` — all validations must pass
- [ ] Do not skip these steps. Do not consider your task done until both are complete.

---

# What is lat.md?

Lat.md is the project's structured knowledge graph for architecture, design decisions, behavior, and tests.

The graph lives in `lat.md/` as cross-linked Markdown describing **what** the project does and **why**. Use it to ground work in actual architecture, and keep it a focused snapshot of the current implemented state rather than a journal or changelog.

Project-specific lat documentation belongs in `lat.md/`. Do not modify this generated instruction file or a generated `lat-md` `SKILL.md` to record project guidance: both are owned by lat tooling and may be replaced by a later `lat init`.

# Commands

Use these commands to navigate and validate the project knowledge graph.

```bash
lat locate "Section Name"      # find a section by name (exact, fuzzy)
lat refs "file#Section"        # find what references a section
lat search "natural language"  # semantic search across all sections
lat external show <handle>      # inspect a pinned external source before cloning it
lat check                      # run full graph and documentation validation
```

Run `lat --help` when in doubt about available commands or options.

If `lat search` fails because no API key is configured, explain to the user that semantic search requires a key provided via `LAT_LLM_KEY` (direct value), `LAT_LLM_KEY_FILE` (path to key file), or `LAT_LLM_KEY_HELPER` (command that prints the key). Supported key prefixes: `sk-...` (OpenAI) or `vck_...` (Vercel). If the user doesn't want to set it up, use `lat locate` for direct lookups instead.

# Syntax primer

Lat uses stable section ids, wiki links, source links, and code references to connect documentation with implementation.

- **Section ids**: `lat.md/path/to/file#Heading#SubHeading` — full form uses project-root-relative path (e.g. `lat.md/tests/search#RAG Replay Tests`). Short form uses bare file name when unique (e.g. `search#RAG Replay Tests`, `cli#search#Indexing`).
- **Wiki links**: `[[target]]` or `[[target|alias]]` — cross-references between sections. Can also reference repository paths or source code: `[[schema.sql]]`, `[[src/components]]`, `[[src/foo.ts#myFunction]]`.
- **Link specificity**: When documenting implemented behavior, prefer the narrowest relevant source-symbol link over a whole-file link. Use whole-file or directory links when discussing the module or resource as a whole, or when no supported symbol represents the target. If prose names a symbol, link that symbol directly.
- **Repository path links**: Wiki links without a `#` fragment may target any existing file or directory inside the project. Unsupported formats validate but cannot be opened by Lat; fragments require a `lat.md/` section or supported source file.
- **Source code links**: Wiki links in `lat.md/` files can reference functions, classes, constants, and methods in supported source files. Use the full path: `[[src/config.ts#getConfigDir]]`, `[[src/server.ts#App#listen]]` (class method), `[[lib/utils.py#parse_args]]`, `[[src/lib.rs#Greeter#greet]]` (Rust impl method), `[[src/app.go#Greeter#Greet]]` (Go method), `[[src/app.h#Greeter]]` (C struct). When prose names an implementation symbol or a behavior governed by one, link the symbol instead of using a bare code span or copying its literal value. Prefer `[[src/config.ts#DEFAULT_TIMEOUT]]` (or an aliased form) over a bare identifier or copied value. `lat check` validates these exist.
- **Code refs**: `// @lat: [[section-id]]` (JS/TS/Rust/Go/C/PHP) or `# @lat: [[section-id]]` (Python/PHP) — ties source code to concepts

# Diagrams

Default to prose. Reserve Mermaid diagrams for concepts involving more than seven interacting subjects (such as components, states, or stages) with complex sequencing, branching, or dependencies that prose alone makes hard to follow.

The subject count alone does not justify a diagram; omit diagrams for simple sequences or relationships that a short paragraph or list explains clearly. A diagram should give users and later agents an overview of the interactions.

Keep each diagram focused on one process, use readable labels, and explain the important decisions in surrounding prose with precise source-symbol links. Prefer a small overview or several focused diagrams over one dense diagram. Use fenced `mermaid` blocks and run `lat check` to validate syntax and readability.

# Test specs

Key tests can be described as sections in `lat.md/` files (e.g. `tests.md`). Add frontmatter to require that every leaf section is referenced by a `// @lat:` or `# @lat:` comment in test code:

```markdown
---
lat:
  require-code-mention: true
---
# Tests

Authentication and authorization test specifications.

## User login

Verify credential validation and error handling for the login endpoint.

### Rejects expired tokens
Tokens past their expiry timestamp are rejected with 401, even if otherwise valid.

### Handles missing password
Login request without a password field returns 400 with a descriptive error.
```

Every section MUST have a description — at least one sentence explaining what the test verifies and why. Empty sections with just a heading are not acceptable. (This is a specific case of the general leading paragraph rule below.)

Each test in code should reference its spec with exactly one comment placed next to the relevant test — not at the top of the file:

```python
# @lat: [[tests#User login#Rejects expired tokens]]
def test_rejects_expired_tokens():
    ...

# @lat: [[tests#User login#Handles missing password]]
def test_handles_missing_password():
    ...
```

Do not duplicate refs. One `@lat:` comment per spec section, placed at the test that covers it. `lat check` will flag any spec section not covered by a code reference, and any code reference pointing to a nonexistent section.

# Section structure

Concise opening paragraphs give every section a stable overview for validation and discovery.

Every section in `lat.md/` **must** have a leading paragraph — at least one sentence immediately after the heading, before any child headings or other block content. The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). This paragraph serves as the section's overview and is used in search results, command output, and RAG context — keeping it concise guarantees the section's essence is always captured.

```markdown
# Good Section

Brief overview of what this section documents and why it matters.

More detail can go in subsequent paragraphs, code blocks, or lists.

## Child heading

Details about this child topic.
```

```markdown
# Bad Section

## Child heading

Details about this child topic.
```

The second example is invalid because `Bad Section` has no leading paragraph. `lat check` validates this rule and reports errors for missing or overly long leading paragraphs.

# lat.md conventions this project enforces

`lat check` fails on the first three rules below. The last three it cannot see,
and they matter as much. None of the six are optional. This block is generated
and a later `lat init` replaces it: record project guidance in `lat.md/`, never
here.

## Every document goes in a Diátaxis mode directory

A document belongs in exactly one of four subdirectories, and `lat check mode`
enforces one shape rule for each:

| Directory | Holds | Shape rule |
| --- | --- | --- |
| `lat.md/tutorials/` | a guided first pass for someone new | an ordered list of steps, and a stated outcome |
| `lat.md/how-to/` | a recipe for a task that recurs | an ordered list of steps |
| `lat.md/reference/` | lookup facts: fields, states, limits, names | no narrative prose (no second paragraph under a heading) |
| `lat.md/explanation/` | why the design is what it is | no imperative commands |

A document is classified either by the directory it sits in, or by declaring
the mode in its own frontmatter:

```markdown
---
lat:
  mode: explanation
---
```

Both are enforced identically: `lat check mode` applies the shape rule to any
document that declares a mode, whether or not the root index carries
`require-mode: true`. That flag adds a separate rule: a document declaring *no*
mode, in no mode directory, becomes an error too.

Prefer the directory in a tree you own outright. Prefer the declaration when
the file cannot move, such as a document another project maintains or a tree
other agents are writing to while you work. Moving costs every reference to the
file; declaring costs nothing at read time, because frontmatter sits above the
first heading and outside every section.

**A document that fails its mode is usually two documents.** A file that lists
the states *and* argues for the design is mixed: the lookup half goes in
`reference/`, the reasoning half in `explanation/`, and each links the other.
Filing it under one mode and softening the prose until the check passes is the
wrong repair.

Classifying a mixed document does not make it pass. Narrative prose put under
`reference/` fails on contact, because a reference may not carry a second
paragraph under a heading, so a move is not a way to adopt the rule cheaply.
Split first, then place. And `explanation` is not the safe default: it bans
only imperative commands, so nearly any prose passes it. Declaring it is a
claim about the document, not somewhere to put whatever is left over. A
document you cannot honestly classify is better left undeclared than
mislabelled.

Classify before writing, not after. If a `diataxis` skill is available, use it.

## Every project has at least one `@lat:` code ref

`lat check` fails a tree that has documents and no `@lat:` ref anywhere in the
codebase. A graph nothing points at cannot be reached from the code, which is
the only reason it exists.

Start at the application entrypoint (`config/application.rb`, `src/index.ts`,
`main.go`, `manage.py`, whatever a new reader opens first) and point it at the
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
quietly: `lat check` fails the moment its target moves or disappears.

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

**Small: a document covers one specialty.** Not one topic area; one
specialty. When a document covers two, it is two documents. Past roughly forty
sections it has almost certainly become several, and an agent then loads all of
it to reach one part.

**Discrete: each document covers its own specialty.** Before writing a new
document, search for the specialty first:

```
lat search "the thing you are about to document"
```

An overlap has two honest repairs, and picking neither is what produces the
third copy. Either the two are one document and belong merged, or the part they
share is its own document that both link. Deciding they are "mostly different"
and writing anyway is how the set rots.

**Does not conflict: two documents never say different things about the same
specialty.** Never restate a fact another document owns. Link to it with
`[[section]]`. A restatement is a second copy, a second copy drifts, and drift
is how document B ends up contradicting document A while both look maintained.

The mode rule above is the sharpest available test of "one specialty": a
document that fails its mode is usually two documents. Split it. Do not soften
the prose until the check passes.

## Write in a tight Strunk & White voice

Diátaxis governs what a document is and where it sits. *The Elements of Style*
governs every sentence inside it. Preserve every fact and design constraint, and
make it land harder in fewer words. When in doubt, ask whether Strunk & White
would red-pen the line.

1. **Omit needless words.** Every word must earn its place. Cut throat-clearing
   ("What this module does is straightforward"). If it is straightforward, the
   prose will show it.
2. **Prefer the active voice.** Passive voice hides the actor and saps energy.
   Name the module, function, or caller that acts ("`scanCodeRefs` walks every
   source file", not "source files are walked").
3. **Put statements in positive form.** Say what something is, not what it is
   not ("The cache stores parsed ASTs in memory", not "The cache does not
   persist across runs").
4. **Be concrete, not corporate.** Replace abstractions with specifics. Name the
   file, symbol, flag, or state instead of gesturing at "workflows",
   "capabilities", or "alignment".
5. **Brevity is courtesy.** Respect the reader's time and context window. A
   tight sentence carries more weight than a padded paragraph.
6. **Let confidence speak quietly.** Do not hedge or oversell. State what the
   code does and what the design trades off. Cut qualifiers ("very",
   "extremely") and exclamation marks.
7. **One thought per sentence.** When a sentence tries to do two things, split
   it so each thought lands.
8. **Reason first, conclusion second.** When a sentence contains both a reason
   and a claim, lead with the reason so the reader follows the logic instead of
   being told the answer and then backfilled ("Most queries touch one section,
   so `lat section` loads only that range" rather than "`lat section` loads only
   that range as most queries touch one section").
9. **Jargon is fine; obscurity is not.** Technical terms are precise when the
   reader knows them. When introducing a project-specific term, define it in
   plain words on first use.
10. **Vary sentence rhythm.** Uniform sentence length sounds robotic. Mix short
    sentences with longer ones that build through a clause or two. A short
    sentence after two longer ones creates emphasis.
11. **No em dashes and no horizontal rules.** Never use em dashes in prose;
    they are an AI tell. Use a colon to introduce a list or elaboration, commas
    or parentheses for an aside, and a period or semicolon between independent
    thoughts. Never use horizontal rules (`---`, `***`, `___`) to separate
    sections; use a blank line or a heading instead. (YAML frontmatter
    delimiters remain `---`.)

## Read sections, not files

`lat search` prints a section id and the exact lines that section occupies.
Resolve it with `lat section`, or read only that line range. Opening the whole
file is the reflex to break, and it is the expensive one:

```
lat search "how does backend selection work"
lat section "cli#CLI#search#Backend selection"
```

not a `read` of `lat.md/cli.md`. Measured on lat.md's own graph, the section
costs 4 KB against the file's 44 KB, eleven times the context for the same
answer, and the answer arrives buried in forty-one sections that were not
asked about.

Use `lat expand` on a prompt carrying `[[refs]]` for the same reason: it
resolves each ref to a location and a preview rather than to a file.
