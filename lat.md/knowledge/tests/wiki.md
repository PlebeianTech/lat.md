---
lat:
  require-code-mention: true
---
# Wiki Tests

Functional and unit specifications for GitHub Wiki export and publication.

## Build Command

Test specifications for the wiki build CLI command.

### Builds Diataxis pages to directory
Verify that the build command compiles Diataxis documents into a wiki bundle in the specified directory.

### Refuses upstream repository
Verify that passing an upstream repository as the repo target is rejected with an error.

### Handles missing git remote cleanly
Verify that building without an explicit repo flag succeeds cleanly when no Git remote is configured.

### Reports error when no Diataxis documents exist
Verify that building fails with an actionable error when the knowledge graph contains no Diataxis documents.

## Publish Command

Test specifications for the wiki publish CLI command.

### Publishes wiki bundle to remote
Verify that publishing commits and pushes the rendered wiki bundle to the target wiki Git repository.

### Dry run commits locally without pushing
Verify that dry-run mode creates a local commit in the cloned worktree without pushing to the remote.
