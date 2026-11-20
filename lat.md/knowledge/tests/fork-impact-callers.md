---
lat:
  require-code-mention: true
---

# Fork Impact Callers

Tests in [[tests/fork-impact-callers.test.ts]] for the `--callers` option of [[cli#impact]]. Each test registers a fixture callers provider through a temporary `XDG_CONFIG_HOME` and runs [[src/cli/impact.ts#impactCommand]] on a temporary project where `foo` links to the target section and `baz` calls `foo`.

## Sections of callers are listed under via callers

When the provider reports `baz` as a caller of `foo`, whose `@lat:` comment links the target, the section linked to `baz` prints under a `via callers` heading after the normal output. The provider is asked for the callers of `foo` at depth 1.

## Without callers the output is unchanged

Without `--callers` the output is exactly the same as before, even with a provider registered.

## Without a provider one note is added

With `--callers` and no callers provider, the output is the normal output plus one line saying that no callers provider is configured.

## A large caller list stays within the budget

With 300 caller sections, the output stays under the output budget and ends with the `more not shown` line.
