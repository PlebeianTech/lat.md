# Explanation

Why this system is shaped the way it is, and what the alternatives cost.

Each document here answers a "why", not a "how". The steps that follow from a decision belong in `how-to/`, and the facts it fixes belong in `reference/`.

<!-- lat:index:begin -->
- [Antigravity and Gemini Support](antigravity.md) — How this fork supports Google Antigravity and Gemini CLI agents alongside Claude Code, using non-intrusive lifecycle hooks and unified conventions.
- [Fork](fork.md) — How this fork of \[vercel-labs/lat.md\]\(https://github.com/vercel-labs/lat.md\) diverges from upstream, and the rules that keep those divergences cheap to carry.
- [Knowledge Federation](knowledge.md) — Looks up related knowledge from external stores when a tagged section is surfaced to an agent, and folds the results into the \[\[cli#hook#UserPromptSubmit\]\] payload. Driven by the \[\[markdown#Frontmatter#tags\]\] field. Entry point: \[\[src/knowledge/index.ts#federateTags\]\].
- [Publishing](fork-publishing.md) — The fork publishes **\`@plebeiantech/lat.md\`** to public npm and attaches the same tarball to a GitHub Release. It never publishes under the name \`lat.md\`, which is upstream's.
- [The upstream guard](upstream-guard.md) — A checker that compares the working tree against the sync point and fails when the diff touches an upstream file that \`fork-upstream-allowlist.tsv\` does not name. It is what turns \[\[fork#Keeping the diff small\]\] from prose into a build step.
- [Untrusted Content](untrusted-content.md) — Framing and sanitization for repository text placed in front of a model. Implementation: \[\[src/untrusted.ts\]\].
<!-- lat:index:end -->
