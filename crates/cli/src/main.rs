//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
//!
//! Usage:
//!   demucs separate --models <dir> [--name htdemucs|htdemucs_ft]
//!       [--two-stems <src>] [--method add|minus] [--shifts N] <input.wav> <out_dir>

use anyhow::{anyhow, bail, Context, Result};
use demucs_core as core;
use std::path::PathBuf;

mod ort_driver;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("separate") => separate(&args[1..]),
        _ => bail!(
            "usage: separate --models <dir> [--name htdemucs|htdemucs_ft] [--two-stems <src>] \
             [--method add|minus] [--shifts N] <input.wav> <out_dir>"
        ),
    }
}

struct Args {
    models_dir: PathBuf,
    name: String,
    mode: core::Mode,
    shifts: u32,
    input: String,
    out_dir: PathBuf,
}

fn parse_args(argv: &[String]) -> Result<Args> {
    let mut models_dir = None;
    let mut name = "htdemucs".to_string();
    let mut two_stems = None;
    let mut method = None;
    let mut shifts = 1u32;
    let mut positional = Vec::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        let mut val = |flag: &str| {
            it.next()
                .map(String::clone)
                .ok_or_else(|| anyhow!("{flag} needs a value"))
        };
        match a.as_str() {
            "--models" => models_dir = Some(PathBuf::from(val("--models")?)),
            "--name" => name = val("--name")?,
            "--two-stems" => two_stems = Some(val("--two-stems")?),
            "--method" => method = Some(val("--method")?),
            "--shifts" => shifts = val("--shifts")?.parse()?,
            _ => positional.push(a.clone()),
        }
    }
    let [input, out_dir]: [String; 2] = positional
        .try_into()
        .map_err(|_| anyhow!("expected <input.wav> <out_dir>"))?;
    Ok(Args {
        models_dir: models_dir.ok_or_else(|| anyhow!("--models <dir> is required"))?,
        name,
        mode: core::Mode::parse(two_stems.as_deref(), method.as_deref())?,
        shifts,
        input,
        out_dir: PathBuf::from(out_dir),
    })
}

fn separate(argv: &[String]) -> Result<()> {
    let args = parse_args(argv)?;
    let bytes = std::fs::read(&args.input).with_context(|| format!("open {}", args.input))?;
    let (raw, rate) = core::decode_wav(&bytes)?;
    if rate != core::SAMPLERATE {
        eprintln!("resampling {rate}Hz -> {}Hz", core::SAMPLERATE);
    }
    let wav = core::resample(core::conform_channels(raw), rate)?;
    eprintln!(
        "input: {} samples ({:.2}s) | model {} | shifts {}",
        wav[0].len(),
        wav[0].len() as f64 / core::SAMPLERATE as f64,
        args.name,
        args.shifts
    );

    let (members, bag) = core::vocab::select(&args.name, args.mode)?;
    let opts = core::Options {
        bag,
        shifts: args.shifts,
        mode: args.mode,
    };

    // the progress line updates in place via \r; end it before other output
    let mid_line = std::cell::Cell::new(false);
    let outputs = ort_driver::run_all(
        &args.models_dir,
        &members,
        wav,
        opts,
        |file| {
            if mid_line.replace(false) {
                eprintln!();
            }
            eprintln!("running {file} ...");
        },
        |done, total| {
            eprint!("\r{done}/{total} chunks");
            mid_line.set(done != total);
            if done == total {
                eprintln!();
            }
        },
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
    std::fs::create_dir_all(&args.out_dir)?;
    for (name, stem) in named {
        let path = args.out_dir.join(format!("{name}.wav"));
        std::fs::write(&path, core::encode_wav(&stem)?)?;
        eprintln!("wrote {}", path.display());
    }
    Ok(())
}
