#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: pnpm release:models -- TAG [--draft]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
tag=$1
shift
draft=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --draft) draft=true ;;
    *) usage ;;
  esac
  shift
done

repo_dir=$(git rev-parse --show-toplevel)
models_dir="$repo_dir/data/onnx-lean"
assets=(
  dft.bin
  htdemucs.onnx
  htdemucs_ft_drums.onnx
  htdemucs_ft_bass.onnx
  htdemucs_ft_other.onnx
  htdemucs_ft_vocals.onnx
)

gh auth status >/dev/null
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
for asset in "${assets[@]}"; do
  if [[ ! -f "$models_dir/$asset" ]]; then
    echo "missing release asset: $models_dir/$asset" >&2
    echo "build the complete set with: pnpm build:model --all" >&2
    exit 1
  fi
done

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
(
  cd "$models_dir"
  sha256sum "${assets[@]}" > "$staging/SHA256SUMS"
)
paths=()
for asset in "${assets[@]}"; do
  paths+=("$models_dir/$asset")
done
paths+=("$staging/SHA256SUMS")

if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  if [[ $draft == true ]]; then
    echo "--draft only applies when creating a release" >&2
    exit 2
  fi
  gh release upload "$tag" "${paths[@]}" --clobber --repo "$repo"
else
  create_args=(
    "$tag"
    "${paths[@]}"
    --repo "$repo"
    --target main
    --title "Demucs ONNX models ($tag)"
    --notes-file "$repo_dir/docs/model-release-notes.md"
  )
  if [[ $draft == true ]]; then
    create_args+=(--draft)
  fi
  gh release create "${create_args[@]}"
fi

gh release view "$tag" --repo "$repo" --json url,isDraft,assets \
  --jq '{url, isDraft, assets: [.assets[].name]}'
