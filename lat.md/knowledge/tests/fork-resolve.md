---
lat:
  require-code-mention: true
---

# Fork Resolve

Tests in [[tests/fork-resolve.test.ts]] for [[src/cli/fork-resolve.ts]], which turns one wiki-link target into a file and line for [[cli#resolve]]. Each test runs against a temporary project with sections, a source file, a plain file and an external source.

## Full section id resolves to its heading line

[[src/cli/fork-resolve.ts#resolveLinkTarget]] returns the absolute path of the section's file and the 1-based line of its heading for a full section id.

## Short section ref resolves like lat check

A short ref such as `guide#Setup` expands through [[packages/core/src/lattice-model.ts#resolveRef]] to the same section that `lat check` validates.

## Ambiguous short ref lists candidates

A short ref that matches more than one file returns an error that names every candidate section id.

## Bracketed ref with alias resolves

Surrounding `[[ ]]` brackets and a `|label` alias are dropped before the ref is resolved.

## Source symbol ref resolves to its declaration line

A `file#symbol` ref to a source file returns the line where the symbol is declared, for a top-level symbol and for a `Class#method` symbol.

## Missing source symbol is an error

A source symbol ref whose symbol does not exist returns the same `symbol ... not found` message that `lat check` reports.

## Source file ref without symbol resolves to line one

A ref to a source file with no `#` fragment returns the file and line 1.

## Source ref with extra symbol parts is an error

A source ref with three or more `#` parts, such as `src/app.ts#a#b#c`, returns the symbol-not-found error, matching `lat check`, which reports such a ref as broken.

## Source ref with empty fragment resolves to line one

A source file ref that ends in a bare `#` returns the file and line 1, matching `lat check`, which accepts an empty fragment.

## Plain file ref resolves to line one

A ref to an existing repository file that is not a source file returns the file and line 1.

## Directory ref is an error

A ref to a repository directory returns the error `directory refs cannot be opened`, because an editor cannot open a directory as a document.

## Unknown ref is an error

A ref that matches no section, source file or repository path returns an error that names the ref.

## External source ref is an error

A ref to a configured external source returns an error saying external refs are not supported, and nothing is fetched.

## CLI prints errors as JSON on stdout

The built CLI, run as a child process, prints the error object as JSON on stdout and exits with code 1.
