# Usage Dashboard

The usage dashboard shows how agents use lat in a project and whether the knowledge in `lat.md/` reaches them. This guide covers enabling tracking, each page, and the command-line equivalents.

Tracking is opt-in and local. Events stay in the project's `.lat/usage/` directory and nothing is sent anywhere. The tool stores pointers such as section ids, file paths, counts and byte lengths. It stores the text of search queries, but not transcript text, search results or command output. [[usage-analytics]] lists every stored field.

## Turn tracking on

Run `lat usage enable` in the project root. It creates `.lat/usage/`, and lat starts recording its own commands, MCP tool calls and hook runs. Setting `LAT_USAGE=1` in the environment enables tracking too.

The directory holds a `.gitignore`, so git never commits it.

Reading usage never turns tracking on. On a project that is not enabled, `lat usage` and `lat usage gaps` say so and change nothing.

`lat usage disable` moves the events to `.lat/usage.disabled/` and stops recording. A later `lat usage enable` restores them. If `.lat/usage.disabled/` already exists, `disable` refuses and tells you to move or delete it first.

The dashboard fills as agents work. A project with no events shows `lat usage enable` in place of charts.

## Open the dashboard

Run `lat ui`, then open `/_usage` on the server it prints, for example `http://localhost:4242/_usage`. The server watches the event files and refreshes open pages when new events arrive.

The leading underscore keeps the dashboard apart from documents: a document at `lat.md/usage.md` or under `lat.md/usage/` keeps its own page at `/usage/...`.

The dashboard needs the `lat ui` server. A static site from `lat ui build` has no usage data to read, so the build leaves `usage.html` out.

The left navigation lists nine pages. A filter bar above them sets a date range and narrows the data to one agent, session or bd issue. The filters live in the address, so a copied link keeps them, and every link between pages carries them.

A value lat could not learn reads "unknown" with its reason. The dashboard never shows it as zero.

## Pages

Each page answers one question.

| Page        | Question it answers                             |
| ----------- | ----------------------------------------------- |
| Overview    | Is lat being used, and is it helping?           |
| Findings    | What specific problems should I fix?            |
| Sessions    | What happened in one agent session?             |
| Issues      | How does usage differ across bd issues?         |
| Knowledge   | Which sections are read, and which are not?     |
| Queries     | What do agents search for, and do they find it? |
| Agents      | How do the five supported agents compare?       |
| Utilization | When and why did agents miss knowledge?         |
| Explore     | What are the raw events behind a number?        |

- **Overview** shows the four health signals, net tokens saved, commands per day and the five biggest findings.
- **Findings** lists every finding with its count, sessions, first and last seen, and a daily sparkline. A kind filter narrows the list. A finding opens a detail view that lists the evidence events with links to Explore, the session and the bd issues involved, and the closest section when one exists. The detail view describes every kind in the table under [Findings](#findings). A `search-miss` detail also links its expected section to the Knowledge page.
- **Sessions** lists sessions, with subagents nested under their parent. A session opens a timeline of its lat commands, bypass reads, bd claims and closes, and injected hook context.
- **Issues** shows bd issues as a tree with own and rolled-up totals. Issues share events, so rows overlap and the table has no grand total. A row above the tree reports activity that matches no issue.
- **Knowledge** ranks the 20 most-read sections, counts the never-read ones, and draws a map of documents sized by bytes and shaded by reads. A pale large block is content that costs upkeep and is rarely read. A section opens a view of its reads over time, the queries that led to reads, the issues that read it, its reach over time, and a list of the git heads where its content changed.
- **Queries** lists normalized search queries with result counts, empty-result share, followed share and reformulations. A query opens a view of the sections it returned and the ranks at which agents opened them.
- **Agents** compares agents on per-session figures, so an agent with many sessions does not win on volume. An agent with no sessions in range shows a row marked "no sessions in range".
- **Utilization** is described in [Utilization and missed knowledge](#utilization-and-missed-knowledge).
- **Explore** lists raw events with facet filters, a group-by control, paging and a JSON-lines export. The table shows each event's time, type, agent, session, lat command name or event kind, section id or file path, exit code and error class, and never the full command text. The export holds the full event records, including search query text and absolute paths such as the repository root and worktree.

## Health signals

Four signals sit on the Overview page. Each tile shows the value for the range, the change against the previous range, and a daily sparkline. A signal with nothing to measure reads "unknown" with its reason.

- **Adoption**: lat commands per session. A low value means agents are not reaching for lat.
- **Search success**: the share of searches with at least one result. Searches whose result count is unknown are left out.
- **Bypass rate**: the share of reads that went around lat, such as an agent opening a file under `lat.md/` with its own read tool instead of `lat section`, out of all section and bypass reads. A high value means agents ignore the lat commands.
- **Knowledge reach**: the share of documented sections an agent was expected to know that it did reach before editing. See [Utilization and missed knowledge](#utilization-and-missed-knowledge).

Net tokens saved is shown beside the four signals and is explained next.

## Net tokens saved

Net tokens saved estimates how many tokens lat spared agents, minus the tokens its hooks injected.

A section read saves the bytes of its whole document, taken from the graph at the git head of the event, minus the bytes the command printed. A hook run costs its injected bytes and saves nothing. Bytes become tokens at 3, 4 and 5 bytes per token, which gives a low, a point and a high estimate. The result is a range because the true ratio varies.

The figure is labelled "correlation, not cause". No run withholds lat from an agent, so the estimate counts what a read might have replaced, not what an agent would have done without lat. The tile names the method version, so a number from an older method is not compared with a newer one.

If all reads, or all hook injections, are unknown, for example because no read recorded its output size, the tile reads "unknown" with the reasons. Per-issue and per-agent values are point values, since there is no range for them. [[usage-analytics#Savings]] has the formula.

## Findings

A finding is a problem lat found in the usage data. The detail view of each says what to do. A detector that fails shows as a visible error and is never read as "no problems". The kind strings are exact.

| Kind                 | Meaning                                                                                       | What to do                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `empty-search`       | A query returned no results.                                                                  | Add or reword a section so it matches the words agents use. The closest section is suggested when one exists.   |
| `bypassed-file`      | Agents read this file under `lat.md/` directly instead of through lat.                        | Make its sections easy to reach through `lat search`, or split the file if it is too large to read through lat. |
| `never-read-section` | No agent read this section in the range.                                                      | Check whether the section is findable, or remove it.                                                            |
| `stale-hot-section`  | One of the 20 most-read sections references code that changed after the section last did.     | Review the section against the code and update it.                                                              |
| `uncovered-hot-file` | Agents edited a file with no documentation in at least three sessions.                        | Write a section for it, and reference the file from the section.                                                |
| `search-miss`        | Agents searched, did not find a section they went on to need, and edited the code without it. | Reword the expected section so the query finds it.                                                              |

`never-read-section` and `stale-hot-section` findings come from the knowledge index, not from events. They have no sessions, first or last seen date or daily counts, so the Findings list shows "—" in those columns and no sparkline.

The stale-section detector reads git history. In a project that is not a git repository it fails, and the Findings page lists `stale-hot-section` as a failed detector. That is expected there.

## Utilization and missed knowledge

The Utilization page shows when and why agents did not gain knowledge through lat, split by the type of the bd issue they worked on, such as bug or feature. Bug fixes and feature changes both touch code that has documentation, so each is checked.

For each session lat finds the documented sections that cover the files the agent edited. These are the expected sections. lat then labels what happened to each expected section before the agent's first edit:

- `reached`: the agent read it before editing.
- `read-late`: the agent read it only after editing.
- `bypassed`: the agent read the document that holds the section directly, not through lat.
- `found-not-opened`: a search returned it and the agent did not open it.
- `searched-not-found`: the agent searched and the section did not come back.
- `never-consulted`: the agent did not look.

Knowledge reach is the share of expected sections that were `reached`. The page shows it per issue type, including an `untyped` bucket for issues with no type and an `unknown` bucket for sessions that worked on no bd issue. A bucket whose reach cannot be computed reads "unknown" with its reason.

These outcomes are inferred, not intended. lat sees what the agent did and not what it meant, so an agent that knew the code and skipped the section looks the same as one that missed it. Expected sections exist only for files that already carried references at the session's first git head, before its own commits, so reach measures changes to existing, documented code. New files and undocumented files are counted apart. Edits to files under `lat.md/` are knowledge edits, not source edits, and are not counted.

The page has six blocks:

- **Knowledge reach by issue type**: a bar list of reach for each issue type.
- **Miss outcomes by issue type**: a stacked chart of the six outcomes for each issue type.
- **Sections to fix first**: a scorecard of sections ranked by misses, each with its main miss and a suggested fix, such as rewording a title for `searched-not-found` or linking the code for `never-consulted`. A row opens the section on the Knowledge page.
- **Did misses cost anything**: compares sessions that reached every expected section with sessions that had a miss.
- **Sessions**: each session with its issue types and its own reach.
- **Findings**: the top `uncovered-hot-file` and `search-miss` findings.

### Did misses cost anything

The comparison covers rework, failed test runs, follow-up bugs, reopened issues and effort, which means tokens and duration. It shows the sample size of each group and the method version.

Some sessions cannot enter a measure, because the follow-up window has not passed yet or the data is missing. lat counts them as left out and states why, so a small sample is visible. It does not treat them as having no effect.

Reopens come from the bd events journal, which keeps seven days and records only this clone. The reopen window is half that retention, 3.5 days by default, and issues closed before the retention are left out.

The comparison is labelled "correlation, not cause". Sessions with a miss may also be the harder ones, so a gap between the groups does not show that the miss caused it.

## Use the data from the command line

Agents and scripts read the same data as the dashboard.

- `lat usage` prints totals, searches, section and bypass reads, injected bytes, token counts, the net tokens saved range and up to ten bd issues. It does not print the health signals. `--json` prints the full aggregate with a `schema_version`. It holds `signals` (adoption as `lat_commands_per_session`, search success, bypass rate and net tokens saved) and, under `extensions.missed_knowledge`, knowledge reach.
- `lat usage gaps` prints a ranked to-do list of findings, with failed detectors named first. It shows 20 lines and then "... N more (use --json)". Findings rank by sessions, then count. `--json` prints the full finding records.
- `lat_usage` is an MCP tool over the same data. Its `view` argument is `summary` (totals, `signals` and `savings`, without knowledge reach) or `findings`. It is registered only when the project already has `.lat/usage/`, and it keeps its output short: ten findings with five evidence ids each.

`lat usage` and `lat usage gaps` share four filters: `--agent <name>`, `--session <id>`, `--issue <id>` for a bd issue and its descendants, and `--since <date>` for an ISO date. The MCP tool takes `agent`, `session`, `issue` and `since`.

```bash
lat usage gaps --since 2026-11-01 --json
```

A `lat usage` run in a project with tracking off prints a reminder to run `lat usage enable`.
