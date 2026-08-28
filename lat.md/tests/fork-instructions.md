---
lat:
  require-code-mention: true
---

# Fork Instructions

Tests for [[src/cli/fork-instructions.ts]], the fork's own instruction channel into a consumer project — the marker block it appends to generated agent files and the conventions skill it writes beside upstream's.

Tests in `tests/fork-instructions.test.ts`, with the end-to-end case in `tests/fork-init-e2e.test.ts`. The invariant under all of them is that upstream's generated files keep working: the fork writes near them, never inside them.

## The block is appended, not merged into upstream's

A `CLAUDE.md` already carrying upstream's `%% lat:begin %%` section keeps that section byte-identical and gains a second `%% lat-fork:begin %%` block after it.

Two independent blocks is what makes the channel free. A single merged section would put the fork's prose inside a span upstream's `appendTemplateSection` rewrites.

## Re-running writes nothing

A second `writeForkInstructions` over an unchanged file leaves it byte-identical, so a repeated `lat init` neither duplicates the block nor reports a spurious modification.

## Upstream can still rewrite its own block

After upstream's marker span is replaced in place — the operation `appendTemplateSection` performs on every re-run — the fork block is still present and still holds the current template.

This is the failure the whole two-marker design exists to avoid, so it is asserted directly rather than inferred from the append test.

## A skill is written only where the agent left a directory

`lat-md-conventions/SKILL.md` appears under a skills root that already exists, and no skills root is created for an agent the user did not select.

Existence of the directory is the signal because the fork does not re-derive upstream's agent-to-path mapping; reading the filesystem stays correct when upstream changes that mapping.

## An edited block is not overwritten silently

A block whose content no longer matches the hash recorded at write time prompts before replacement, keeps the user's text when the answer is no, and takes the current template when the answer is yes.

## Nothing is created for an agent that was not set up

A project with no generated instruction files gains none: no `CLAUDE.md`, no `AGENTS.md`, no `.github/`.

## The block carries the rules the check enforces

The template names the four mode directories, the `require-mode` flag, the comment-convention exemption, and the language-allowlist correction — the four things a consumer's agent has been observed to get wrong.

Asserting on the text is unusual, but the template is the deliverable here. A silent edit that dropped the exemption paragraph would leave every other test passing.

## The block demands one specialty per document

The template states all three halves of the rule — that a document is small, that it is discrete, and that it does not conflict — and names `[[section]]` linking as the alternative to restating a fact another document owns.

Stating one or two halves is the likely silent regression: "keep documents small" alone reads as advice about length and leaves the overlap and contradiction cases unaddressed, which are the two that actually corrupt a documentation set.

## The block tells the agent to read sections rather than files

The template names `lat section` and `lat expand` as the way to reach a section found by `lat search`, and says in as many words not to open the whole file.

This is the one rule in the block that no check enforces, which is exactly why it is asserted here. A silent edit dropping it would cost every consumer project an order of magnitude of context per lookup and break no test otherwise.

## A real init lands the block and the scaffold together

A full `initCmd` run with Claude Code selected produces a `CLAUDE.md` carrying both marker blocks, a `lat-md-conventions` skill beside upstream's `lat-md`, and a `lat.md/` with the four mode directories and `require-mode: true`.

The unit tests above call `writeForkInstructions` directly, so none of them would notice the call being dropped from `initCmd` or running before the files it writes into exist. This is the case that would.
