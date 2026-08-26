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
# 2. It resolves the CLI once, in one place, and verifies what it found. A
#    globally installed `lat` may be UPSTREAM's build rather than this fork's,
#    and an upstream binary has none of the checks the hooks below assume.
#    That used to be undetectable, because both builds reported 0.12.2; the
#    fork now carries a `-fork` prerelease suffix, so the check is a version
#    comparison rather than a hardcoded path.
#
# Every path exits 0. A hook must never fail the tool call that triggered it.

set -u

START="${CLAUDE_PROJECT_DIR:-$PWD}"

# How to invoke the CLI, in two parts so neither a plugin path nor a binary
# path has to survive word splitting: LAT_PRE is an optional interpreter and
# LAT_BIN is what it runs. LAT_CMD is the same thing spelled for a human.
LAT_PRE=""
LAT_BIN=""
LAT_CMD=""

# Two sources, in order of confidence.
#
# A dist/ beside the plugin means the plugin is being run straight out of a
# development checkout of the fork, and that build is by definition the one
# whose hooks these are. Installed from a marketplace there is no dist/ — the
# plugin ships hooks only, because the built CLI needs ~170MB of node_modules
# beside it and no plugin repo should carry that.
#
# Otherwise take `lat` from PATH, but only if it identifies itself as a fork
# build. Upstream's CLI would accept `hook claude UserPromptSubmit` and answer
# it without any of the checks these hooks exist to run, which is worse than
# not running at all: the session would look grounded and would not be.
if [ -f "${CLAUDE_PLUGIN_ROOT:-}/dist/src/cli/index.js" ]; then
  LAT_PRE="node"
  LAT_BIN="${CLAUDE_PLUGIN_ROOT}/dist/src/cli/index.js"
  LAT_CMD="node ${CLAUDE_PLUGIN_ROOT}/dist/src/cli/index.js"
elif command -v lat >/dev/null 2>&1; then
  case "$(lat --version 2>/dev/null)" in
    *-fork*)
      LAT_BIN="lat"
      LAT_CMD="lat"
      ;;
  esac
fi

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
  [ -n "$LAT_BIN" ] || exit 0
  cd "$lat_root" || exit 0

  # `check` is housekeeping, not a hook protocol: its stdout is a human
  # progress line, not the JSON envelope Claude Code expects back from a
  # hook, and a tree that fails a check for some unrelated reason must not
  # surface as a failing hook after every edit.
  if [ "${1:-}" = "check" ]; then
    if [ -n "$LAT_PRE" ]; then
      "$LAT_PRE" "$LAT_BIN" "$@" >/dev/null 2>&1 || true
    else
      "$LAT_BIN" "$@" >/dev/null 2>&1 || true
    fi
    exit 0
  fi

  if [ -n "$LAT_PRE" ]; then
    exec "$LAT_PRE" "$LAT_BIN" "$@"
  fi
  exec "$LAT_BIN" "$@"
fi

# No lat.md/ anywhere above the project root. Tell the agent to create one,
# but only on UserPromptSubmit — the other events have no channel to say it
# in, and repeating it after every edit would be noise rather than a prompt
# to act.
if [ "${1:-}" = "hook" ] && [ "${3:-}" = "UserPromptSubmit" ]; then
  # The notice names the resolved command rather than a bare `lat`, because
  # `lat init` writes hook registrations naming whichever binary ran it. The
  # resolution above has already rejected a non-fork build, so whatever
  # LAT_CMD holds is safe to bootstrap through.
  [ -n "$LAT_CMD" ] || exit 0
  cat <<'JSON' | sed "s|__LAT_CLI__|$LAT_CMD|g"
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"This project has no `lat.md/` directory. Run `__LAT_CLI__ init` to create one before doing substantial work, so design intent has somewhere to live and this session can be grounded in it. Use that exact command — a bare `lat` on PATH may be upstream's build rather than this fork's, and initialising with it wires the project to a binary without these checks. Structure what you write in `lat.md/` by Diataxis mode: every document is a tutorial, a how-to, a reference, or an explanation, declared as `mode:` under its `lat:` frontmatter and placed in the matching directory. `__LAT_CLI__ check mode` enforces that, and `__LAT_CLI__ check` must pass before you finish. If this project should never use lat.md, create an empty `.lat-disable` file at its root to stop this notice."}}
JSON
fi

exit 0
