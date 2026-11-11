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
