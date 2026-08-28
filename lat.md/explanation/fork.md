# Fork

How this fork of [vercel-labs/lat.md](https://github.com/vercel-labs/lat.md) diverges from upstream, and the rules that keep those divergences cheap to carry.

The fork publishes as `@plebeiantech/lat.md` and never under upstream's `lat.md` name. Its remote is `PlebeianTech/lat.md`; `upstream` is a fetch-only remote whose push URL is disabled.

## Keeping the diff small

Every upstream file this fork edits is a merge conflict waiting to happen. A file we only add is not, so new behaviour belongs in new fork-owned files.

The target shape for anything that must reach upstream code: a new module holding the logic, plus an import and one call line in the upstream file. `src/cli/check-status.ts` and `src/cli/check-frontmatter.ts` are the reference implementations — each is a new file whose entire upstream footprint is an import and one appended line in `checkAllCommand`.

Five rules follow from that, in the order they are worth applying.

### Never delete an upstream file

A deleted file that upstream later modifies produces a delete/modify conflict on **every** future merge. A modified file conflicts once and stays resolved.

Leave an unwanted upstream file in place and change what it does, or turn it off out of band.

### Keep tests in fork-owned files

A test for fork-owned code has no reason to live in an upstream test file, and appending to one converts a zero-cost addition into a permanent conflict site.

### Change things at the fork-owned end of a call

When our code calls upstream's, adjust the result in our file rather than editing theirs. Only reach into an upstream function when no fork-owned call site exists.

### Docs are ours, so write our own

Fork-specific documentation belongs in fork-owned files like this one, linked from upstream docs rather than written into them. That keeps an upstream doc's diff to a link.

### Name a new file something upstream would not reach for

Two files added independently never conflict in git and can still collide in the graph, because a short-form `[[name]]` reference resolves by bare filename.

`lat.md/tests/graph.md` and upstream's later `lat.md/view/graph.md` are the worked example — see [[merge-upstream#Merging upstream#What a clean merge still breaks]]. Prefer a name that says what the fork-owned thing is, not the general topic it sits under.

## The instruction channel

What `lat init` teaches a consumer project's agent reaches it through a fork-owned template and a fork-owned marker block, so the fork can say more without editing upstream's onboarding text.

Upstream's channel is two files: `templates/AGENTS.md`, written into `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md` inside `%% lat:begin %%` markers, and `templates/skill/SKILL.md`, written whole into each agent's skills directory. Both are upstream's own agent-facing prose and among the files upstream most often revises, so every sentence the fork adds is a conflict bought on credit.

`templates/fork/conventions.md` replaces that. [[src/cli/fork-instructions.ts#writeForkInstructions]] appends it under its own `%% lat-fork:begin %%` / `%% lat-fork:end %%` markers and writes it again, with frontmatter, as a separate `lat-md-conventions` skill. The whole upstream footprint is one import and one call in `initCmd`.

Moving the fork's existing Diátaxis prose into it took `templates/AGENTS.md` off [[upstream-guard#The upstream guard#The allowlist]] entirely and returned `templates/skill/SKILL.md` to upstream's exact bytes — the diff got *smaller* while the instruction got stronger. Test spec: [[tests/fork-instructions]].

### Why two markers rather than one section

Upstream's `appendTemplateSection` rewrites the span between its own markers in place, splicing around whatever sits outside them.

A fork block after `%% lat:end %%` is therefore untouched by every upstream re-run, and upstream's block is untouched by every fork re-run. Merging the two into one section would give both writers the same span and make the last one to run the winner.

### Why the skill is a separate file

Upstream writes its `lat-md` skill with `writeTemplateFile`, which compares a hash of the **whole** file against the one recorded at write time.

Appending to that file changes the whole-file hash, so every later `lat init` would report the skill as user-modified and stop to ask. A second skill directory has no such coupling. It also earns its keep: `lat-md` is upstream's authoring syntax, `lat-md-conventions` is what `lat check` fails on here.

### What the template demands

Five rules, each written because an agent was observed to miss it.

Every document goes in a Diátaxis mode directory, and a document that would fail its mode is two documents rather than one softened one. Every project carries at least one `@lat:` ref, starting at the application entrypoint and pointing at the root index. An `@lat:` pointer is a machine directive and is exempt from any project convention that minimises comments — and the marker is a comment syntax, not a language allowlist, so no example list should be read as an exclusion.

The last two no check can enforce, which is why the template argues them rather than asserting them. One is about writing: a document covers one specialty, overlapping documents are merged or have their shared part lifted into a third, and a fact another document owns is linked rather than restated — a second copy drifts, and drift is how two documents end up contradicting each other while both look maintained. The other is about reading: reach a section with `lat section` or `lat expand`, never by opening the file it lives in. A `lat.md/` file holds tens of unrelated sections, so the file costs roughly an order of magnitude more context than the section that answers the question. The template carries the measurement rather than the assertion, because an agent that has seen 4 KB against 44 KB stops reflexively opening files.

## The Diátaxis gate

`lat init` scaffolds the four mode directories into a fresh `lat.md/` and stamps [[markdown#Frontmatter#require-mode]] into the root index, so a project set up after this existed cannot quietly place its documents where no shape rule reaches them.

[[cli#check#mode]] binds only inside `tutorials/`, `how-to/`, `reference/` and `explanation/`. A tree whose documents all sit flat at the top therefore passes every mode rule by never being subject to one — and an agent asked to document a codebase writes flat files, because upstream's `templates/init/` is one root index and nothing suggests otherwise. A bella-derms session did exactly that, and confirmed on request that its largest document produced 64 errors the moment it was copied into `reference/`.

Two halves, and the order matters. [[src/cli/fork-scaffold.ts#writeForkScaffold]] makes the directories exist, each with an index written to satisfy its own mode, so correct placement is the path of least resistance. The `require-mode` flag then makes flat placement an error rather than an option. Structure without the gate is a suggestion; the gate without structure is an error message with nowhere to point. Test spec: [[tests/fork-scaffold]].

### Why the flag lives in the tree

An opt-in flag in the root index, rather than a CLI flag or an environment variable, is what lets the rule ship without breaking anything.

This repository's own `lat.md/` predates the gate. Gating every tree would fail it on the commit that introduced the gate, and the honest repair — assigning modes and then splitting the documents that fail them — is real restructuring work that has nothing to do with shipping the rule. A flag read from the tree makes adoption a decision each project makes once.

### Why this repository classifies but does not gate

`require-mode` is not set here, and the documents this fork owns still declare a mode.

The flag does not gate enforcement. [[cli#check#mode]] checks any document that declares a `mode`, whether or not the flag is set — verified by declaring `mode: reference` on a document in an ungated tree and watching the check report 28 errors. What the flag adds is the second half of the rule: every document that declares *no* mode becomes an error too.

That second half is what this tree cannot afford. It is tree-wide by design, and 29 of the documents it would flag are upstream's — 23 of them files the fork does not touch at all today. Setting it would add 23 entries to [[upstream-guard#The upstream guard#The allowlist]] and a merge surface in 23 files, to state a mode for documents upstream writes and this fork only reads.

So the fork classifies what it owns and claims nothing about what it does not. Every fork-owned document is enforced against its declared mode; an upstream document is left alone. Declaring a mode costs nothing at read time either — frontmatter sits above the first heading, outside every section range, so it never reaches `lat search`, `lat section`, `lat expand` or the hook.

The `lat.md/tests/` specs are deliberately left undeclared. Their genre is closest to `reference`, and most are one or two paragraphs away from passing it, but the paragraph that would have to go is the one saying *why* a test exists — which [[cli#check#code-refs]] coverage rules ask for. Picking `explanation` instead because it passes would be choosing a label over a description, which is the repair this project tells everyone else not to make.

### Adopting it in a tree that already exists

`writeForkScaffold` runs only on the branch that creates `lat.md/`, so `lat init` offers the flag separately to every tree it did not create.

The first version had no such offer, which left the gate unreachable for exactly the projects that needed it: a re-run on an existing project picked up the instruction block and the conventions skill and silently skipped the flag. Restructuring someone's tree unasked is still wrong, so the offer prints how many documents would need a mode, then asks. A refusal is recorded in a fork-owned `lat.md/.cache/lat_fork.json` and never asked again; a run with no TTY prints the frontmatter to paste and records nothing, because the shared `ask` returns true whenever readline is absent and a silent yes is the one answer this must not give.

The count comes from running [[cli#check#mode]] twice, gated and ungated, and reporting the difference — so it is the checker's own number rather than a second copy of its rules, and it excludes documents that are already failing, which cost nothing to adopt. [[src/cli/fork-scaffold.ts#planRequireMode]] decides whether the flag can be written *before* the question is asked, because a yes that cannot be honoured is worse than never offering: asking first once left a tree with four new directories, a rewritten index and no gate, and a message saying nothing could be edited. When the flag cannot land nothing is written, nothing is recorded, and the reason is printed every run until the user fixes it — a defect they can repair is not something to remember, and remembering it is what silenced the recovery.

Only an unparseable root index or a `lat:` key holding a list or a scalar reaches that path now. Everything else merges, because the flag is set through the YAML document API rather than by editing lines: `parseDocument` already knows where the block ends, which indented lines belong to `lat:` rather than to the next key, and whether the value on the `lat:` line is a flow mapping or an anchor. Line surgery had to infer all of it from raw text, and got each one wrong in turn.

### What the scaffold writes

Four directories, four indexes, and two additions to the root index.

Each mode index is written to the rule it will be checked against rather than to one house style: the tutorial index carries ordered steps and a stated outcome, the how-to index carries ordered steps, the reference index carries no second paragraph. The root index gains the `require-mode` frontmatter and a listing of the four directories — the listing because without it `lat check index` reports four missing entries on a tree `lat init` has just created, which is a poor first impression of a tool whose pitch is that the check passes.

All of it is conditional on the flag landing. [[src/cli/fork-scaffold.ts#writeForkScaffold]] decides that before it writes anything, and writes nothing when the answer is no: four directories with the gate off reads as adopted to [[cli#check#mode]] and passes, and four directories the root index does not list fails [[cli#check#index]] instead. Half-adoption is worse than none in both directions.

## The code-ref floor

A `lat.md/` tree that holds documents and has no `@lat:` ref pointing into it from anywhere in the codebase fails `lat check`, whatever its frontmatter says.

[[markdown#Frontmatter#require-code-mention]] was the only thing asking for refs, and it is opt-in: an agent setting up a tree can decline to write it and every check still passes. One did, and gave two reasons worth recording because neither was carelessness. It read "Supported comment styles: `//` (JS/TS/Rust/Go/C) and `#` (Python)" as an exclusive list and concluded Ruby was unsupported — the list enumerates comment syntaxes, and [[src/code-refs.ts#scanCodeRefs]] is textual and reads every non-markdown file. And it was optimising for a green check rather than a correct one, so of two paths it took the one that could not fail.

The floor is one ref, not a ratio. A per-document rule would fail this repository, where `dev-process`, `markdown`, `parser`, `website` and everything under `view/` have no incoming ref and are not worse for it — the rule would have to be either wrong here or watered down everywhere. Test spec: [[tests/check-coverage]].

### Why the entrypoint is named in the message rather than checked

Naming the application entrypoint means guessing per framework, and a check that guesses wrong is a check that gets turned off.

`config/application.rb`, `manage.py`, `main.go`, `src/index.ts`, a Cargo bin target — the right answer differs per project and sometimes per directory. So the gate counts refs and the failure message names the convention, quoting the root index's own H1 so the suggested line can be pasted as-is. A generic placeholder would be pasted verbatim and then fail [[cli#check#code-refs]], turning one error into two.

`~/plebtech/sway` arrived at the same convention by hand before any of this existed: `config/application.rb` and `app/frontend/entrypoints/application.tsx` each carry a ref to the root index, one per entrypoint.

### Why the message argues rather than instructs

Two of the three paragraphs in the failure exist to answer an objection the reader already holds.

An agent working in a repository whose convention is that comments are untrusted input — subtractive, budgeted, justified — is right about prose comments and will apply that rule here unless told the boundary. So the message says what an `@lat:` line is: a machine directive in the same class as `# frozen_string_literal:` or `// eslint-disable`, carrying no rationale and unable to rot quietly, because `lat check` fails the moment its target moves. The other paragraph corrects the language-allowlist reading directly, at the moment it matters.

## Turning a workflow off without editing it

Whether a GitHub Actions workflow runs is repository **state**, not file content, so a workflow can be disabled without appearing in the diff at all.

```
gh workflow disable "<name>" --repo PlebeianTech/lat.md
gh workflow enable  "<name>" --repo PlebeianTech/lat.md
gh workflow list --all --repo PlebeianTech/lat.md
```

The cost is that the state is invisible in a checkout: someone cloning the repository cannot tell from the files why a workflow never runs. Record any use of it here, and prefer editing the workflow when the edit is small — CI files are explicitly fine to edit in this fork.

Nothing is disabled at present. Both workflows run: `ci.yml` builds, tests, and runs `lat check` from source, and `lat-check.yaml` installs the published package and checks the tree with it.

## Continuous integration

Two workflows validate the tree, and both run our own build of `lat` rather than upstream's.

`ci.yml` runs `pnpm buildall`, the `vitest` suite, and then `lat check` using the binary that commit just built. Checking with the source build rather than a published one is the stricter choice: a change to the check rules is validated by its own checker in the same run.

`lat-check.yaml` installs the published `@plebeiantech/lat.md` and runs `lat check` with it. That is deliberately redundant with the source-built check — it smoke-tests the published tarball against a real repository, which a source build cannot do.

Upstream's version of `lat-check.yaml` used `lars20070/lat-check-action@v1`, whose `action.yaml` hardcodes `npm install -g lat.md` with no input to override it. Upstream's `parseIndexEntries` matches only `- [[name]] — description`. This fork's writes `- [Label](dest.md) — description` and its parser reads both, so upstream's sees zero entries in our index files and reports every child as missing. It never once passed. Pinning it to a commit would have fixed the mutable-tag exposure without fixing the failure.

Windows is not in the `ci.yml` matrix. The POSIX-path and `eol=lf` conventions in [[dev-process#Testing#Continuous Integration]] still hold, but no runner enforces them.
