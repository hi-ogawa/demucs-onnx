#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: pnpm download:models -- TAG [MEMBER ...]" >&2
  echo "members: htdemucs htdemucs_ft_drums htdemucs_ft_bass htdemucs_ft_other htdemucs_ft_vocals" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
tag=$1
shift
all_members=(
  htdemucs
  htdemucs_ft_drums
  htdemucs_ft_bass
  htdemucs_ft_other
  htdemucs_ft_vocals
)
members=("${all_members[@]}")
if [[ $# -gt 0 ]]; then
  members=("$@")
fi

for member in "${members[@]}"; do
  supported=false
  for candidate in "${all_members[@]}"; do
    if [[ $member == "$candidate" ]]; then
      supported=true
      break
    fi
  done
  if [[ $supported == false ]]; then
    echo "unknown model member: $member" >&2
    usage
  fi
done

gh auth status >/dev/null
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
repo_dir=$(git rev-parse --show-toplevel)
output="$repo_dir/data/onnx-lean"
output_parent=$(dirname "$output")
mkdir -p "$output_parent"
staging=$(mktemp -d "$output_parent/.onnx-lean.download-XXXXXX")
trap 'rm -rf "$staging"' EXIT

patterns=(--pattern dft.bin --pattern SHA256SUMS)
expected=(dft.bin)
for member in "${members[@]}"; do
  patterns+=(--pattern "$member.onnx")
  expected+=("$member.onnx")
done
gh release download "$tag" --repo "$repo" --dir "$staging" "${patterns[@]}"

for asset in "${expected[@]}" SHA256SUMS; do
  if [[ ! -f "$staging/$asset" ]]; then
    echo "release $tag is missing asset: $asset" >&2
    exit 1
  fi
done
(
  cd "$staging"
  sha256sum --check --ignore-missing SHA256SUMS
)

backup=""
if [[ -e "$output" ]]; then
  backup=$(mktemp -d "$output_parent/.onnx-lean.old-XXXXXX")
  rmdir "$backup"
  mv "$output" "$backup"
fi
if ! mv "$staging" "$output"; then
  if [[ -n $backup ]]; then
    mv "$backup" "$output"
  fi
  exit 1
fi
if [[ -n $backup ]]; then
  rm -rf "$backup"
fi
trap - EXIT
echo "downloaded ${#members[@]} model(s) and dft.bin to $output"
