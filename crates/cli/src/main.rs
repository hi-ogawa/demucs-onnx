//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
//!
use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use demucs_core as core;
use std::path::PathBuf;

mod ort_driver;

#[derive(Debug, Parser)]
#[command(about = "Portable Demucs inference using ONNX Runtime")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Separate a WAV file into stems
    Separate(SeparateArgs),
}

#[derive(Args, Debug)]
struct SeparateArgs {
    /// Directory containing ONNX models
    #[arg(long = "models", value_name = "DIR")]
    models_dir: PathBuf,

    /// Model name
    #[arg(long, default_value = "htdemucs", value_name = "MODEL")]
    name: String,

    /// Emit a source and its complement
    #[arg(long, value_name = "SOURCE")]
    two_stems: Option<String>,

    /// Two-stem method: add or minus
    #[arg(long, value_name = "METHOD")]
    method: Option<String>,

    /// Number of seeded-offset passes
    #[arg(long, default_value_t = 1, value_name = "N")]
    shifts: u32,

    /// Input WAV file
    #[arg(value_name = "INPUT.WAV")]
    input: String,

    /// Directory for generated stems
    #[arg(value_name = "OUT_DIR")]
    out_dir: PathBuf,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Separate(args) => separate(args),
    }
}

fn separate(args: SeparateArgs) -> Result<()> {
    let mode = core::Mode::parse(args.two_stems.as_deref(), args.method.as_deref())?;
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

    let (members, bag) = core::vocab::select(&args.name, mode)?;
    let opts = core::Options {
        bag,
        shifts: args.shifts,
        mode,
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;

    #[test]
    fn top_level_help() {
        let error = Cli::try_parse_from(["demucs", "--help"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        assert!(error.to_string().contains("separate"));
    }

    #[test]
    fn separate_help() {
        let error = Cli::try_parse_from(["demucs", "separate", "--help"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        assert!(error.to_string().contains("--models <DIR>"));
    }

    #[test]
    fn separate_defaults() {
        let cli = Cli::try_parse_from([
            "demucs",
            "separate",
            "--models",
            "models",
            "input.wav",
            "out",
        ])
        .unwrap();
        let Command::Separate(args) = cli.command;
        assert_eq!(args.name, "htdemucs");
        assert_eq!(args.shifts, 1);
    }

    #[test]
    fn missing_models_is_an_error() {
        let error = Cli::try_parse_from(["demucs", "separate", "input.wav", "out"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
    }

    #[test]
    fn unknown_option_is_an_error() {
        let error = Cli::try_parse_from([
            "demucs",
            "separate",
            "--models",
            "models",
            "--unknown",
            "input.wav",
            "out",
        ])
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::UnknownArgument);
    }
}
