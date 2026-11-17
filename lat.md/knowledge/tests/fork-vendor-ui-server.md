---
lat:
  require-code-mention: true
---

# Fork Vendor UI Server

Tests in [[tests/fork-vendor-ui-server.test.ts]] for [[scripts/fork-vendor-ui-server.ts]], run against a small fixture tree so `lat ui build server` keeps working from the vendored copy.

## The vendored server reads its own version

The vendored server reads `../package.json` beside its entry, as upstream's package does, so a consumer that asks for the server version gets the version and not `ENOENT`.

## Only import specifiers are rewritten

The script rewrites `from '@lat.md/server'` to a relative path and leaves the same string alone as a dependency key, so the generated server `package.json` still names `@lat.md/server`.
