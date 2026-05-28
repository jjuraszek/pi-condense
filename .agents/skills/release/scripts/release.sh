#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  release.sh [--dry-run] [--no-update-pins] <major|minor|patch>

Examples:
  release.sh patch
  release.sh --dry-run minor
  release.sh --no-update-pins patch    # skip the ~/.pi/agent.*/settings.json pin bump

Default behavior: after pushing the new tag, every ~/.pi/agent*/settings.json
that pins this repo (git:github.com/jjuraszek/pi-context-prune@<ref>) is
rewritten in-place to @vX.Y.Z so subsequent pi launches pick up the release.
EOF
}

DRY_RUN=0
UPDATE_PINS=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=1; shift ;;
    --no-update-pins) UPDATE_PINS=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                break ;;
  esac
done

BUMP_TYPE="${1:-}"
if [[ -z "$BUMP_TYPE" ]]; then
  usage
  exit 1
fi

case "$BUMP_TYPE" in
  major|minor|patch) ;;
  *)
    echo "error: bump type must be one of: major, minor, patch" >&2
    usage >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../" && pwd)"
cd "$REPO_ROOT"

# Pin pattern matched/rewritten in user settings.json files. Kept narrow on
# purpose: only the jjuraszek fork URL is bumped automatically. Anything else
# (upstream, alt forks) is left alone.
PIN_REPO="github.com/jjuraszek/pi-context-prune"
PIN_PREFIX="git:${PIN_REPO}@"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: working tree is not clean; commit or stash changes before releasing" >&2
    git status --short >&2 || true
    exit 1
  fi
}

# Rewrites every ~/.pi/agent*/settings.json that pins this repo so the @<ref>
# (sha or older tag) becomes @<new-tag>. Uses Python because jq isn't required
# and we want to preserve formatting / round-trip the JSON safely.
update_settings_pins() {
  local new_tag="$1"
  local mode="$2"   # "apply" or "dry"
  local found_any=0
  shopt -s nullglob
  for settings in "$HOME"/.pi/agent*/settings.json; do
    if ! grep -q "${PIN_PREFIX}" "$settings"; then
      continue
    fi
    found_any=1
    if [[ "$mode" == "dry" ]]; then
      echo "would update pin in: $settings"
      grep -nH "${PIN_PREFIX}" "$settings" | sed "s|@[^\"]*|@${new_tag}|" || true
      continue
    fi
    python3 - "$settings" "$PIN_PREFIX" "$new_tag" <<'PY'
import json, sys, pathlib
path, pin_prefix, new_tag = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
data = json.loads(path.read_text())
pkgs = data.get("packages")
if not isinstance(pkgs, list):
    print(f"  skipped (no packages array): {path}")
    sys.exit(0)
changed = []
for i, entry in enumerate(pkgs):
    if isinstance(entry, str) and entry.startswith(pin_prefix):
        old_ref = entry[len(pin_prefix):]
        if old_ref == new_tag:
            continue
        pkgs[i] = pin_prefix + new_tag
        changed.append((old_ref, new_tag))
if not changed:
    print(f"  no-op (already at {new_tag}): {path}")
    sys.exit(0)
path.write_text(json.dumps(data, indent=2) + "\n")
for old, new in changed:
    print(f"  bumped {path}: @{old} -> @{new}")
PY
  done
  shopt -u nullglob
  if [[ "$found_any" -eq 0 ]]; then
    echo "  no ~/.pi/agent*/settings.json files pin ${PIN_REPO}; nothing to bump"
  fi
}

if [[ ! -f package.json ]]; then
  echo "error: package.json not found at repo root: $REPO_ROOT" >&2
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
CURRENT_BRANCH="$(git branch --show-current)"

if [[ "$DRY_RUN" -eq 0 ]]; then
  require_clean_tree
fi

run git fetch origin

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  run git checkout main
fi

run git pull --ff-only origin main

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Dry run note: working tree is not clean right now; a real release would stop here until it is clean."
  fi
  echo "Current version: $OLD_VERSION"
  echo "Current branch: $CURRENT_BRANCH"
  echo "Dry run only: would run npm run build --if-present"
  echo "Dry run only: would run npm run check --if-present"
  echo "Dry run only: would run npm version $BUMP_TYPE -m 'Release %s'"
  echo "Dry run only: would push main and the generated tag to origin"
  if [[ "$UPDATE_PINS" -eq 1 ]]; then
    NEXT_VERSION="$(node -p "
      const v=require('./package.json').version.split('.').map(Number);
      const t='$BUMP_TYPE';
      if(t==='major'){v[0]++;v[1]=0;v[2]=0;}
      else if(t==='minor'){v[1]++;v[2]=0;}
      else{v[2]++;}
      v.join('.')
    ")"
    echo "Dry run only: would bump ~/.pi/agent*/settings.json pins to v${NEXT_VERSION}:"
    update_settings_pins "v${NEXT_VERSION}" dry
  else
    echo "Dry run only: --no-update-pins given; would skip pin bump"
  fi
  exit 0
fi

run npm run build --if-present
run npm run check --if-present

NEW_TAG="$(npm version "$BUMP_TYPE" -m "Release %s")"
NEW_VERSION="${NEW_TAG#v}"

run git push origin main
run git push origin "$NEW_TAG"

NEW_SHA="$(git rev-parse HEAD)"

if [[ "$UPDATE_PINS" -eq 1 ]]; then
  echo "Updating pi settings.json pins to ${NEW_TAG}:"
  update_settings_pins "$NEW_TAG" apply
else
  echo "Skipping pin update (--no-update-pins). Bump manually if needed:"
  echo "  grep -nrH '${PIN_PREFIX}' \$HOME/.pi/agent*/settings.json"
fi

cat <<EOF
Release complete.
Old version: $OLD_VERSION
New version: $NEW_VERSION
Tag: $NEW_TAG
Commit: $NEW_SHA
Pushed: origin/main and $NEW_TAG
EOF
