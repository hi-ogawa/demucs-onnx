//! Node binding for the demucs port: demucs-core engine + ort inference, exposed via napi-rs.
//!
//! v0 surface: file -> stem files, mirroring the CLI. Buffer-level API and the wasm/emnapi
//! target (inference delegated to onnxruntime-web) come later.

use anyhow::Context;
use demucs_core as core;
use napi_derive::napi;
use std::path::Path;

fn js_err(e: anyhow::Error) -> napi::Error {
    napi::Error::from_reason(format!("{e:#}"))
}

#[napi(object)]
#[derive(Default)]
pub struct SeparateOptions {
    /// Source name for two-stems mode (e.g. "bass")
    pub two_stems: Option<String>,
    /// "add" (default) or "minus"
    pub method: Option<String>,
    /// Passes to average (default 1 = single plain pass; 2+ = seeded-offset shift trick)
    pub shifts: Option<u32>,
}

/// Separate `input` (wav) into stems under `out_dir`; returns written file paths.
#[napi]
pub fn separate(
    models_dir: String,
    model_name: String,
    input: String,
    out_dir: String,
    options: Option<SeparateOptions>,
) -> napi::Result<Vec<String>> {
    let opts = options.unwrap_or_default();
    let mode =
        core::Mode::parse(opts.two_stems.as_deref(), opts.method.as_deref()).map_err(js_err)?;
    let shifts = opts.shifts.unwrap_or(1);

    run(&models_dir, &model_name, &input, &out_dir, mode, shifts).map_err(js_err)
}

fn run(
    models_dir: &str,
    model_name: &str,
    input: &str,
    out_dir: &str,
    mode: core::Mode,
    shifts: u32,
) -> anyhow::Result<Vec<String>> {
    let bytes = std::fs::read(input).with_context(|| format!("open {input}"))?;
    let (raw, rate) = core::decode_wav(&bytes)?;
    let wav = core::resample(core::conform_channels(raw), rate)?;
    let (members, bag) = core::vocab::select(model_name, mode)?;
    let opts = core::Options { bag, shifts, mode };

    let outputs = demucs_ort_driver::run_all(
        Path::new(models_dir),
        &members,
        wav,
        opts,
        |_| {},
        |_, _| {},
    )?;

    let named: Vec<(String, [Vec<f32>; core::CHANNELS])> = match outputs {
        core::Outputs::Full(stems) => core::Source::ALL
            .into_iter()
            .zip(stems)
            .map(|(s, p)| (s.name().to_string(), p))
            .collect(),
        core::Outputs::TwoStems {
            source,
            target,
            complement,
        } => vec![
            (source.name().to_string(), target),
            (format!("no_{}", source.name()), complement),
        ],
    };
    std::fs::create_dir_all(out_dir)?;
    let mut written = Vec::new();
    for (name, stem) in named {
        let path = Path::new(out_dir).join(format!("{name}.wav"));
        std::fs::write(&path, core::encode_wav(&stem)?)?;
        written.push(path.to_string_lossy().into_owned());
    }
    Ok(written)
}
