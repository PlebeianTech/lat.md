#!/bin/sh
#
# Single entry point for every lat.md plugin hook.
#
# Why a guard script instead of naming the CLI directly in hooks.json:
#
# 1. A plugin's hooks fire in EVERY project on the machine, but `lat` only has
#    something to say in a project that has a lat.md/ tree. `hook claude Stop`
#    and `hook claude PostToolUse` already return early on their own, but
#    `hook claude UserPromptSubmit` does not — it emits its "run lat search"
#    reminder unconditionally. Without this guard, installing the plugin would
#    inject that reminder into every prompt in every unrelated repository.
#
# 2. It resolves the CLI through $CLAUDE_PLUGIN_ROOT rather than $PATH. A
#    globally installed `lat` may be a DIFFERENT BUILD than this one and
#    reports the same version string, so $PATH cannot be trusted to pick the
#    right binary. This is not hypothetical: it had already happened on this
#    machine before the plugin existed.
#
# Every path exits 0. A hook must never fail the tool call that triggered it.

set -u

START="${CLAUDE_PROJECT_DIR:-$PWD}"
CLI="${CLAUDE_PLUGIN_ROOT:-}/dist/src/cli/index.js"

# Escape hatch for a repository that should never be treated as a lat.md
# project, so the bootstrap notice below can be silenced permanently.
if [ -n "${LAT_DISABLE:-}" ] || [ -f "$START/.lat-disable" ]; then
  exit 0
fi

# Defer to a project that registers its own lat hooks.
#
# `lat init` writes `lat hook claude <Event>` entries into a project's
# .claude/settings.json, and those fire IN ADDITION to this plugin's - so any
# project that has ever been through `lat init` runs every event twice: two
# identical context blocks per prompt, and two of every timeout. `lat init` is
# upstream code and cannot be taught that the plugin exists, so the plugin
# yields instead. Whoever configured the project explicitly wins.
#
# Deference is per EVENT, not whole-file, so a project that registers only some
# events still gets the plugin's others. The event name can be matched
# literally because `lat init` writes it into the command string itself
# ("lat hook claude UserPromptSubmit"), which makes a plain grep exact and
# keeps a JSON parser out of a path that runs on every prompt.
if [ "${1:-}" = "hook" ] && [ -n "${2:-}" ] && [ -n "${3:-}" ]; then
  for settings in \
    "$START/.claude/settings.json" \
    "$START/.claude/settings.local.json"
  do
    [ -f "$settings" ] || continue
    if grep -q "hook $2 $3" "$settings" 2>/dev/null; then
      exit 0
    fi
  done
fi

# Walk up for a lat.md/ directory, the same way the CLI locates one itself.
lat_root=""
dir="$START"
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -d "$dir/lat.md" ]; then
    lat_root="$dir"
    break
  fi
  parent=$(dirname "$dir")
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

if [ -n "$lat_root" ]; then
  [ -f "$CLI" ] || exit 0
  cd "$lat_root" || exit 0

  # `check` is housekeeping, not a hook protocol: its stdout is a human
  # progress line, not the JSON envelope Claude Code expects back from a
  # hook, and a tree that fails a check for some unrelated reason must not
  # surface as a failing hook after every edit.
  if [ "${1:-}" = "check" ]; then
    node "$CLI" "$@" >/dev/null 2>&1 || true
    exit 0
  fi

  exec node "$CLI" "$@"
fi

# No lat.md/ anywhere above the project root. Tell the agent to create one,
# but only on UserPromptSubmit — the other events have no channel to say it
# in, and repeating it after every edit would be noise rather than a prompt
# to act.
if [ "${1:-}" = "hook" ] && [ "${3:-}" = "UserPromptSubmit" ]; then
  # The command is spelled out absolutely, not as bare `lat init`, on purpose.
  # A `lat` on $PATH may be a DIFFERENT BUILD that reports the same version
  # string, and `lat init` writes hook registrations naming whichever binary
  # ran it — so bootstrapping through the wrong one silently wires the project
  # to the wrong lat and none of this build's checks ever run.
  cat <<'JSON' | sed "s|__LAT_CLI__|$CLI|g"
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"This project has no `lat.md/` directory. Run `node __LAT_CLI__ init` to create one before doing substantial work, so design intent has somewhere to live and this session can be grounded in it. Use that exact command — a bare `lat` on PATH may be a different build of this tool that reports the same version number, and initialising with it wires the project to the wrong binary. Structure what you write in `lat.md/` by Diataxis mode: every document is a tutorial, a how-to, a reference, or an explanation, declared as `mode:` under its `lat:` frontmatter and placed in the matching directory. `node __LAT_CLI__ check mode` enforces that, and `node __LAT_CLI__ check` must pass before you finish. If this project should never use lat.md, create an empty `.lat-disable` file at its root to stop this notice."}}
JSON
fi

exit 0
