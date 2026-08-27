# Markdown

Extensions to standard markdown used in `lat.md` files.

## Wiki Links

Obsidian-style links: `[[target]]` or `[[target|alias]]`. Uses `|` as the alias divider.

Targets are section ids — hierarchical paths like `lat.md/dev-process#Testing#Running Tests`. The vault root is the project directory (the parent of `lat.md/`), so all markdown section ids include the `lat.md/` prefix. Wiki links can also reference source code symbols — see [[markdown#Wiki Links#Source Code Links]].

Validated by [[cli#check#md]].

### Resolution Rules

Aligned with Obsidian conventions:

- **`[[foo]]`** — link to the **file** `foo.md`. Resolves to the root section of that file. Does not search section headings.
- **`[[foo#Bar]]`** — heading `Bar` in file `foo.md`. The path after `#` must be an exact heading chain — no intermediate headings can be omitted.
- **`[[path/foo#Bar]]`** — fully qualified: file `path/foo.md`, heading `Bar`.

Heading segments accept either their literal Obsidian form (`Some Section!`) or their GitHub slug (`some-section`). Resolution always returns and displays the canonical literal-heading section id, so existing links and CLI output remain unchanged. Literal matches win if the two forms collide.

### Short Path Disambiguation

Short refs are supported for markdown files inside `lat.md/` only. When a file stem is unique across the vault, it can be used without its directory prefix.

For example, `[[setup#Install]]` resolves to `lat.md/guides/setup#Install` if `setup.md` only exists under `lat.md/guides/`.

When multiple files share the same stem (e.g. `alpha/notes.md` and `beta/notes.md`), the short form is ambiguous — [[cli#check#md]] reports an error listing all candidates. If the referenced section exists in only one file, the error suggests the specific fix.

Source code references (e.g. `[[src/config.ts#getConfigDir]]`) always require the full path — no short refs for source files.

Resolution is handled by [[src/lattice.ts#resolveRef]]. See [[parser#Short Ref Resolution]] for implementation details.

### Source Code Links

Wiki links can reference symbols in TypeScript, JavaScript, Python, Rust, Go, and C source files:

- **`[[src/config.ts#getConfigDir]]`** — the `getConfigDir` function in `src/config.ts`
- **`[[src/server.ts#App#listen]]`** — the `listen` method on class `App` in `src/server.ts`
- **`[[src/lib.rs#Greeter#greet]]`** — the `greet` method on struct `Greeter` in Rust
- **`[[src/app.go#Greeter#Greet]]`** — the `Greet` method on type `Greeter` in Go
- **`[[src/app.h#Greeter]]`** — the `Greeter` struct in a C header
- **`[[src/app.h#Greeter#prefix]]`** — the `prefix` field of struct `Greeter` in C
- **`[[src/config.ts]]`** — link to the file itself (no symbol)

Supported extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.c`, `.h`.

Python symbols: functions, classes, methods, module-level variables. Decorated definitions (`@decorator`) are unwrapped transparently — `[[file.py#my_func]]` resolves whether or not `my_func` has decorators, and `# @lat:` comments placed between decorators and the `def`/`class` line are scanned normally.

Rust symbols: functions, structs, enums, traits, impl methods, consts, statics, type aliases. Methods are resolved via `impl` blocks — `[[file.rs#Type#method]]` matches any `impl Type { fn method() }` or `impl Trait for Type { fn method() }`.

Go symbols: functions, types (structs, interfaces, type aliases), methods (with receiver), consts, vars. Methods are resolved via receiver type — `[[file.go#Type#Method]]` matches `func (t *Type) Method()`.

C symbols: functions (including pointer-returning like `char *func()`), structs, struct fields/members, enums, enum values (including anonymous enums and `typedef enum` members), typedefs, `#define` macros (both object-like and function-like), variables (including arrays). Struct fields are resolved via the parent struct — `[[file.h#Struct#field]]` matches any `field_declaration` inside `struct Struct { ... }`, including fields nested inside anonymous unions and structs. Enum values can be referenced standalone (`[[file.h#GREEN]]`) or qualified by their enum name (`[[file.h#Color#GREEN]]`); both forms work for named enums, `typedef enum`, and named `typedef enum`. Both `.c` and `.h` files are supported — include guards (`#ifndef`/`#endif`) are walked through transparently.

Source code is parsed lazily with tree-sitter (via `web-tree-sitter`). Only files referenced by wiki links are parsed — no up-front scanning. [[cli#check#md]] validates that the file exists and the symbol is defined.

### Strict vs Lenient Contexts

**Strict** — `lat check` and `lat refs` use `resolveRef()` directly. Links must resolve unambiguously to a known section. Ambiguous or broken links are errors.

**Lenient** — `lat locate` and `lat expand` use `findSections()`, which applies tiered matching (exact → file stem → subsection tail → fuzzy). These commands are for interactive exploration and accept approximate queries.

## Relative Links

Ordinary markdown links (`[text](path)`) to local files are validated for existence, so a moved or deleted file is caught the same way a stale `[[wiki link]]` is.

Targets resolve against the containing file's directory. A link that leaves `lat.md/` (`../../AGENTS.md`) is checked like any other. Inline links, images, and reference definitions (`[id]: ./path.md`) all participate; code samples and bracket-like text in raw HTML do not.

Fragments targeting Markdown files must match a GitHub-style heading id. GitHub lowercases headings, removes punctuation, replaces spaces with hyphens, and suffixes duplicate ids with `-1`, `-2`, and so on. Bare fragments target the containing file and are validated the same way.

Full (`[text][id]`) and collapsed (`[id][]`) references without a matching definition are errors. An undefined shortcut form (`[id]`) is indistinguishable from bracketed prose and remains text, following CommonMark parsing.

Destinations that are not local paths are skipped and never reported:

- **Any URI scheme** — `https:`, `mailto:`, and a Windows absolute path like `C:/notes.md`.
- **Root-absolute and protocol-relative** — `/img/logo.png`, `//example.com/x`. Ambiguous between a site root and the filesystem root.

A `?query` is dropped before resolving. Fragments on non-Markdown targets are ignored because they are not heading ids.

Local paths must use `/` separators on every operating system. Literal and
percent-encoded backslashes are rejected because GitHub treats them as filename
characters rather than Windows path separators. This restriction does not
apply to lat wiki links or code references. Diagnostics display filesystem
paths with `/` separators on every operating system.

Validated by [[cli#check#links]].

## Leading Paragraph

Every section must have a leading paragraph — at least one sentence immediately after the heading, before any child headings.

The first paragraph must be ≤250 characters (excluding `[[wiki link]]` content). It serves as the section's overview for search results, command output, and RAG context. Subsequent paragraphs can go into detail.

Validated by [[cli#check#sections]].

## Frontmatter

`lat.md` files support YAML frontmatter for per-file configuration:

```yaml
---
lat:
  require-code-mention: true
---
```

Every field below nests under the top-level `lat:` mapping shown above. A field written at the document root instead (no `lat:` wrapper) is silently ignored by every check it would otherwise turn on, and `lat check` now reports it as an error naming the field and showing the fix.

### require-code-mention

When set to `true`, [[cli#check#code-refs]] ensures every leaf section (sections with no children) in the file has a corresponding `// @lat: [[...]]` reference in source code. Useful for test specs and requirements that must be traceable to implementation.

### mode

Declares which of the four Diátaxis modes a document is: `tutorial`, `how-to`, `reference`, or `explanation`.

```yaml
---
lat:
  mode: how-to
---
```

`mode` is optional — a document placed inside `lat.md/tutorials/`, `lat.md/how-to/`, `lat.md/reference/`, or `lat.md/explanation/` gets that directory's mode inferred automatically, even with no frontmatter at all. Declaring `mode` explicitly is only required for a document outside those four directories, and if a document is inside one of them, a declared mode must match the directory — a mismatch is an error, not an override.

Once a mode applies (declared or inferred), [[cli#check#mode]] enforces content rules for it:

- **`tutorial`** — must contain an ordered (numbered) list, and must state its outcome (a heading or sentence saying what the reader will have by the end).
- **`how-to`** — must contain an ordered (numbered) list of steps.
- **`reference`** — must not contain narrative prose: no section may have a second paragraph under its heading (use a list, table, or code block instead).
- **`explanation`** — must not give commands: no line may open with an imperative verb (`Run`, `Install`, `Configure`, etc.) outside a heading or code block.

An unknown `mode` value is always an error, regardless of directory.

### require-mode

Set on the **root index only**. When `true`, every document in the tree that is neither a directory index nor covered by [[markdown#Frontmatter#mode]] — by declaration or by sitting in a mode directory — is a [[cli#check#mode]] error.

```yaml
---
lat:
  require-mode: true
---
```

The flag is opt-in and lives in the tree rather than in a CLI flag or an environment variable, because the rule belongs to a documentation set and a tree that predates it has to keep passing. [[cli#init]] stamps it into the root index it scaffolds, so a project set up after this existed is gated from its first commit. See [[fork#The Diátaxis gate]].

Only `true` and `false` are accepted, and `false` is a durable opt-out that [[cli#init]] does not re-offer. Any other value is a [[cli#check#mode]] error rather than a silent off — `yes` and `1` are a string and a number to a YAML 1.2 parser, so a root index that looks gated to its author would otherwise enforce nothing and say nothing.

### status

Records who last vouches for a document's prose: whether a person has read and checked it, or an agent produced it and no one has reviewed it since.

```yaml
---
lat:
  status: human-reviewed
---
```

Permitted values are `human-reviewed` and `agent-extracted`; any other value is an error from [[cli#check#status]]. The status is surfaced as an inline annotation by `lat section` and `lat search` — for example `[unreviewed -- written by an agent, not checked by a person]` for `agent-extracted`, or `[stale review -- the text changed after a person checked it]` for a `human-reviewed` document whose text has since drifted (see `reviewed-hash` below). A document with no `status` field gets no annotation at all.

### reviewed-hash

Pairs with `status: human-reviewed` to make a stale review detectable — the hash pins the reviewed prose so a later edit can be caught rather than silently continuing to claim review.

```yaml
---
lat:
  status: human-reviewed
  reviewed-hash: 3f1a9c2e
---
```

Record it as at least 8 hex characters — a prefix of the full SHA-256 is enough. [[cli#check#status]] reports the current hash to record whenever one is missing or needs updating.

A `human-reviewed` document with **no** `reviewed-hash` is accepted — it is not an error — but it buys no staleness detection at all: nothing will ever flag that document as stale, no matter how much its text changes. Only a document that has a hash and is `human-reviewed` gets that protection.

The hash covers the document's prose only: headings and frontmatter are excluded. Retitling a section, reordering headings, or editing an unrelated frontmatter field never invalidates a review — only a change to the reviewed body text does. Setting `reviewed-hash` on an `agent-extracted` document is itself an error, since a hash records that a person checked the text.

### tags

A list of freeform keywords used to look up related knowledge from external stores (project memory, team knowledge bases) when a section is surfaced during search.

```yaml
---
lat:
  tags: [run-pin, carry, query-param]
---
```

A single string is also accepted for one tag. Only the first two tags drive the actual lookup — list the most important ones first, since order is preserved and never resorted. Any result is prefixed with a notice that it is untrusted, auto-searched content to verify before relying on it.
