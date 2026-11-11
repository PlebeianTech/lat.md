---
lat:
  require-code-mention: true
---

# Gen GitHub Wiki Workflow Tests

Functional tests for wiki workflow template rendering and placeholder substitution.

## Workflow Template Rendering

Verifies template loading and placeholder substitution for the GitHub Wiki publication workflow.

### Replaces placeholders and preserves action syntax
Verifies that template placeholders are replaced while GitHub Actions expressions remain intact.

### Produces valid workflow structure with build and publish jobs
Verifies that rendered output parses as valid YAML containing build and publish jobs.

### Configures push branch
Verifies that target branch defaults to main and accepts custom branch values.

### Configures node version
Verifies that node-version step defaults to lts/* and accepts custom versions.

### Injects current package name and version
Verifies that the global install step references the package name and version from package.json.

## CLI Command

Functional tests for the gen CLI command emitting the GitHub Wiki workflow.

### Replaces placeholders and preserves action syntax through stdout
Captures stdout to verify template placeholders resolve and GitHub Actions expressions survive.

### Modifies workflow output with branch and node options
Verifies that passing custom branch and node version options alters emitted workflow text.

### Preserves existing target behavior when options are supplied
Verifies that passing workflow options to unrelated targets leaves output unchanged.

### Exits with error code and lists supported targets on unknown target
Verifies that unknown target names trigger exit code one and display supported targets including github-wiki-workflow.

### Wires CLI flags through commander to workflow generation
Spawns the CLI with branch and node-version flags to verify end-to-end commander option wiring.
