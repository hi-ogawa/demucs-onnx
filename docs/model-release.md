# Model releases

GitHub Releases distribute the size-optimized ONNX models separately from the application. Normal local development downloads these artifacts; rebuilding them is only necessary when changing the export pipeline or preparing new model bytes.

## Download for local development

Prerequisites are Python, `gh` authenticated with access to the repository, and `pnpm`:

```bash
gh auth status
pnpm models download models-v1
pnpm build:wasm
pnpm dev
```

The download command retrieves all five ONNX files, `dft.bin`, and `SHA256SUMS` into `data/onnx-lean/`. It verifies checksums before replacing an existing model directory.

Pass member names after the tag to download only a useful subset:

```bash
# Standard four-stem and two-stem modes.
pnpm models download models-v1 htdemucs

# Fine-tuned bass/minus mode.
pnpm models download models-v1 htdemucs_ft_bass
```

Every subset includes `dft.bin`. A partial download replaces `data/onnx-lean/`, so only the selected workflows remain available locally.

## Build and publish

Model maintainers need Python with `uv` in addition to the download prerequisites. Build the complete release set locally:

```bash
pnpm build:model --all
```

Create a release and upload the six model assets plus generated checksums by choosing an explicit tag:

```bash
pnpm models release models-v1
```

To review a new release before publication, create it as a draft:

```bash
pnpm models release models-v1 --draft
```

Rerunning the command for an existing tag replaces same-named assets but preserves whether that release is draft, prerelease, or published. `--draft` is rejected for an existing release because the script does not implicitly change release state.

Inspect or publish a release explicitly:

```bash
gh release view models-v1 --json url,isDraft,assets
gh release edit models-v1 --draft=false
```

Prefer a new tag such as `models-v2` when model bytes change. Overwriting a published release makes previously recorded checksums stale and should be reserved for correcting an upload before consumers depend on it.
