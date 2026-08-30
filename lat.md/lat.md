This directory defines the high-level concepts, business logic, and architecture of this project using markdown. It is managed by [lat.md](https://www.npmjs.com/package/lat.md) — a tool that anchors source code to these definitions. Install the `lat` command with `npm i -g lat.md` and run `lat --help`.

**Markdown-first.** This project is built around markdown and its output should reflect that. CLI error messages, diagnostics, and reports use structured, readable formatting — bullet-point lists, indented context, and clear spacing between items — so output is scannable both by humans and by LLM-based agents consuming it.

<!-- lat:index:begin -->
- [CLI](cli.md) — The \`lat\` command line tool. Entry point: \[\[src/cli/index.ts\]\].
- [Dev Process](dev-process.md) — Development workflow, tooling, and conventions for the lat.md project.
- [Explanation](explanation/explanation.md) — Why this system is shaped the way it is, and what the alternatives cost.
- [How-to](how-to/how-to.md) — Recipes for tasks that recur, written for someone who already knows what they want.
- [Markdown](markdown.md) — Extensions to standard markdown used in \`lat.md\` files.
- [Parser](parser.md) — Markdown parsing built on unified/remark v11. Entry point: \[\[src/parser.ts\]\]. Parse → render fidelity is verified by \[\[tests/roundtrip\]\].
- [Tests](tests/tests.md) — High-level test descriptions. Actual test code lives in \`tests/\`.
- [View](view/view.md) — The local browser turns a \`lat.md\` vault into navigable rendered documentation while keeping the installed runtime small.
- [Website](website.md) — Standalone Next.js app in \`website/\`. Deployed to Vercel at \`lat.md\`.
<!-- lat:index:end -->
