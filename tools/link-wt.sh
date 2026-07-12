#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
main_worktree=$(git worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    "worktree "*) printf '%s\n' "${line#worktree }"; break ;;
  esac
done)

if [[ "$repo_root" == "$main_worktree" ]]; then
  echo "link-wt: already in the main worktree" >&2
  exit 1
fi

source_data="$main_worktree/data"
target_data="$repo_root/data"

if [[ ! -d "$source_data" ]]; then
  echo "link-wt: source data directory does not exist: $source_data" >&2
  exit 1
fi

if [[ -e "$target_data" || -L "$target_data" ]]; then
  echo "link-wt: target already exists: $target_data" >&2
  exit 1
fi

ln -s "$source_data" "$target_data"
echo "Linked $target_data -> $source_data"
