# Publishing documentation to GitHub Wiki

Export Diátaxis documentation from `lat.md/` and publish it to the repository's GitHub Wiki tab using [[cli#CLI#wiki]].

## Prerequisites

Initialize the companion wiki Git repository on GitHub before publishing.

GitHub provisions `<repo>.wiki.git` on demand when an administrator creates the first wiki page through the web interface.

1. Navigate to the repository settings tab on GitHub and verify that the Wikis feature is enabled.
2. Open the repository Wiki tab in your browser.
3. Create the initial home page and click Save.
4. Clone access to `<repo>.wiki.git` is now available for automated tooling.

## Publishing Steps

Follow this workflow to preview, verify, and publish documentation updates.

1. **Preview locally:** run `lat wiki build` to compile Diátaxis pages into `.lat-build/wiki/`. Inspect `Home.md`, `_Sidebar.md`, and the transformed Markdown documents to verify formatting and link targets.
2. **Verify publish readiness:** run `lat wiki publish --dry-run` to clone `<repo>.wiki.git` into a temporary directory, render the bundle, and create a local test commit without pushing.
3. **Publish live:** run `lat wiki publish` to invoke [[src/cli/wiki.ts#wikiPublishCommand]], which commits the bundle, prunes stale wiki pages, and pushes directly to the companion wiki remote.
4. **Confirm on GitHub:** refresh the repository Wiki tab to view the live documentation with sidebar navigation.
