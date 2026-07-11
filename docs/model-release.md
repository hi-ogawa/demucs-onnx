# Model releases

GitHub Releases distribute the size-optimized ONNX models separately from the application. Normal local development downloads these artifacts; rebuilding them is only necessary when changing the export pipeline or preparing new model bytes.

## Download for local development

Prerequisites are Python, `gh` authenticated with access to the repository, and `pnpm`:

```bash
gh auth status
pnpm model-release download models-2026-07-11
```

The download command retrieves all five ONNX files and `dft.bin` into `data/onnx-lean/`. It replaces an existing model directory only after the requested assets have downloaded successfully.

Pass member names after the tag to download only a useful subset:

```bash
# Standard four-stem and two-stem modes.
pnpm model-release download models-2026-07-11 htdemucs

# Fine-tuned bass/minus mode.
pnpm model-release download models-2026-07-11 htdemucs_ft_bass
```

Every subset includes `dft.bin`. A partial download replaces `data/onnx-lean/`, so only the selected workflows remain available locally.

## Build and publish

Model maintainers need Python with `uv` in addition to the download prerequisites. Build the complete release set locally:

```bash
pnpm build-model --all
```

Verify each unstripped export against the original PyTorch forward path. The standard model does not need a member index; fine-tuned member indices are `0=drums`, `1=bass`, `2=other`, and `3=vocals`:

```bash
pnpm verify-parity --onnx data/onnx/htdemucs.onnx --stripped-onnx data/onnx-lean/htdemucs.onnx --model htdemucs
pnpm verify-parity --onnx data/onnx/htdemucs_ft_bass.onnx --model htdemucs_ft --index 1
```

The command exits unsuccessfully when maximum absolute error or mean squared error exceeds its threshold. Use `--max-abs` and `--max-mse` to override the defaults when investigating numerical differences. When `--stripped-onnx` is provided, its output must exactly match the unstripped export.

Create a release and upload the six model assets by choosing an explicit tag:

```bash
pnpm model-release release models-2026-07-11
```

Update an existing release by explicitly replacing its same-named assets:

```bash
pnpm model-release release models-2026-07-11 --update
```

Inspect a release with:

```bash
gh release view models-2026-07-11
```

Prefer a new date-based tag when model bytes change. Overwriting a published release should be reserved for correcting an upload before consumers depend on it.
