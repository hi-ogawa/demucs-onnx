//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use console::style;
use demucs_core as core;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::path::PathBuf;
use std::time::{Duration, Instant};

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

    /// Separation model: standard (htdemucs) or fine-tuned (htdemucs_ft)
    #[arg(
        long,
        default_value = "htdemucs",
        value_name = "MODEL",
        value_parser = ["htdemucs", "htdemucs_ft"],
        hide_possible_values = true
    )]
    name: String,

    /// Output SOURCE and a mix without it instead of all four stems
    #[arg(
        long,
        value_name = "SOURCE",
        value_parser = ["drums", "bass", "other", "vocals"],
        hide_possible_values = true,
        long_help = "Output SOURCE and a mix without it instead of all four stems. Sources: drums, bass, other, vocals"
    )]
    two_stems: Option<String>,

    /// How to create the mix without SOURCE
    #[arg(
        long,
        value_name = "METHOD",
        value_parser = ["add", "minus"],
        hide_possible_values = true,
        long_help = "How to create the mix without SOURCE: add sums the other stems; minus subtracts SOURCE from the original mix. Default: add"
    )]
    method: Option<String>,

    /// Number of processing passes to average; more passes take proportionally longer
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
    let total_started = Instant::now();
    let mode = core::Mode::parse(args.two_stems.as_deref(), args.method.as_deref())?;
    let prepare_started = Instant::now();
    let bytes = std::fs::read(&args.input).with_context(|| format!("open {}", args.input))?;
    let (raw, rate) = core::decode_wav(&bytes)?;
    if rate != core::SAMPLERATE {
        eprintln!("resampling {rate}Hz -> {}Hz", core::SAMPLERATE);
    }
    let wav = core::resample(core::conform_channels(raw), rate)?;
    let prepare_elapsed = prepare_started.elapsed();
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

    eprintln!("prepared audio in {}", format_duration(prepare_elapsed));
    let mut progress = CliProgress::new();
    let outputs = ort_driver::run_all(&args.models_dir, &members, wav, opts, |event| {
        progress.update(event)
    })?;
    progress.finish();

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
    let write_started = Instant::now();
    let stem_count = named.len();
    for (name, stem) in named {
        let path = args.out_dir.join(format!("{name}.wav"));
        std::fs::write(&path, core::encode_wav(&stem)?)?;
        eprintln!("wrote {}", path.display());
    }
    let write_elapsed = write_started.elapsed();
    let total_elapsed = total_started.elapsed();
    eprintln!(
        "complete: {stem_count} stems in {} (load {}, inference {}, finalize {}, write {})",
        format_duration(total_elapsed),
        format_duration(progress.load_elapsed),
        format_duration(progress.inference_elapsed),
        format_duration(progress.finalize_elapsed),
        format_duration(write_elapsed),
    );
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
        let help = error.to_string();
        assert!(help.contains("--models <DIR>"));
        assert!(help.contains("standard (htdemucs) or fine-tuned (htdemucs_ft)"));
        assert!(help.contains("Output SOURCE and a mix without it instead of all four stems"));
        assert!(help.contains("Sources: drums, bass, other, vocals"));
        assert!(help.contains("add sums the other stems"));
        assert!(help.contains("minus subtracts SOURCE from the original mix"));
        assert!(help.contains("more passes take proportionally longer"));
        assert!(!help.contains("possible values"));
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

// Interactive layouts stay model-oriented while the overall row remains stable:
//   htdemucs.onnx
//     Load      done | 5.2s
//     Separate  [======----] 65% | 11/17 | running
//   Overall     [======----] 65% | 11/17 | elapsed 00:00:42 (ETA 00:00:23)
// Multi-model runs repeat the heading and phase rows as Model 1/4, Model 2/4, etc.
struct CliProgress {
    multi: MultiProgress,
    overall: ProgressBar,
    phase: Option<ProgressBar>,
    load_elapsed: Duration,
    inference_elapsed: Duration,
    finalize_elapsed: Duration,
    loaded: usize,
    eta: Option<Duration>,
    model_chunks: usize,
}

impl CliProgress {
    fn new() -> Self {
        let multi = MultiProgress::new();
        let overall = multi.add(ProgressBar::new(0));
        Self {
            multi,
            overall,
            phase: None,
            load_elapsed: Duration::ZERO,
            inference_elapsed: Duration::ZERO,
            finalize_elapsed: Duration::ZERO,
            loaded: 0,
            eta: None,
            model_chunks: 0,
        }
    }

    fn update(&mut self, event: ort_driver::Progress<'_>) {
        use ort_driver::Progress;
        match event {
            Progress::Started { total_chunks } => {
                self.overall.set_style(
                    ProgressStyle::with_template(
                        "Overall     [{bar:16.cyan/bright_black}] {percent:>3}% | {pos}/{len} | elapsed {elapsed_precise}{msg:.dim}",
                    )
                    .unwrap()
                    .progress_chars("=>-"),
                );
                self.overall.set_length(total_chunks as u64);
                self.overall.enable_steady_tick(Duration::from_millis(250));
            }
            Progress::LoadStarted {
                index,
                total,
                file,
                chunks,
            } => {
                let heading = if total == 1 {
                    file.to_string()
                } else {
                    format!("Model {index}/{total}  {file}")
                };
                let _ = self
                    .multi
                    .println(format!("{}", style(heading).bold().for_stderr()));
                self.model_chunks = chunks;
                let phase = self
                    .multi
                    .insert_before(&self.overall, ProgressBar::new_spinner());
                phase.set_style(ProgressStyle::with_template("  Load      running").unwrap());
                phase.tick();
                self.phase = Some(phase);
                self.overall.set_message(format_eta(self.eta));
            }
            Progress::LoadFinished { elapsed } => {
                self.load_elapsed += elapsed;
                self.loaded += 1;
                if let Some(phase) = self.phase.take() {
                    phase.finish_and_clear();
                }
                let _ = self.multi.println(format!(
                    "  Load      {} | {}",
                    style("done").green().for_stderr(),
                    format_duration(elapsed)
                ));
                let phase = self
                    .multi
                    .insert_before(&self.overall, ProgressBar::new(self.model_chunks as u64));
                phase.set_style(
                    ProgressStyle::with_template(
                        "  Separate  [{bar:16.cyan/bright_black}] {percent:>3}% | {pos}/{len}{msg} | running",
                    )
                    .unwrap()
                    .progress_chars("=>-"),
                );
                phase.tick();
                self.phase = Some(phase);
                self.overall.set_message(format_eta(self.eta));
            }
            Progress::Inference {
                done,
                total,
                members,
                shift,
                shifts,
                member_done,
                elapsed,
            } => {
                self.inference_elapsed += elapsed;
                self.overall.set_length(total as u64);
                self.overall.set_position(done as u64);
                if let Some(phase) = &self.phase {
                    phase.set_position(member_done as u64);
                    phase.set_message(if shifts == 1 {
                        String::new()
                    } else {
                        format!(" | shift {shift}/{shifts}")
                    });
                }
                let remaining_chunks = total - done;
                let chunk_eta = self
                    .inference_elapsed
                    .mul_f64(remaining_chunks as f64 / done as f64);
                let remaining_loads = members - self.loaded;
                let load_eta = if self.loaded == 0 {
                    Duration::ZERO
                } else {
                    self.load_elapsed
                        .mul_f64(remaining_loads as f64 / self.loaded as f64)
                };
                self.eta = Some(chunk_eta + load_eta);
                self.overall.set_message(format_eta(self.eta));
            }
            Progress::MemberFinished { chunks, elapsed } => {
                if let Some(phase) = self.phase.take() {
                    phase.finish_and_clear();
                }
                let _ = self.multi.println(format!(
                    "  Separate  {} 100% | {chunks}/{chunks} | {} {}",
                    style("[================]").cyan().for_stderr(),
                    style("done").green().for_stderr(),
                    format_duration(elapsed)
                ));
                self.overall.set_message(format_eta(self.eta));
            }
            Progress::FinalizeStarted => {
                let phase = self
                    .multi
                    .insert_before(&self.overall, ProgressBar::new_spinner());
                phase.set_style(ProgressStyle::with_template("  Finalize  running").unwrap());
                phase.tick();
                self.phase = Some(phase);
                self.overall.set_message("");
            }
            Progress::FinalizeFinished { elapsed } => {
                self.finalize_elapsed = elapsed;
                if let Some(phase) = self.phase.take() {
                    phase.finish_and_clear();
                }
                let _ = self.multi.println(format!(
                    "  Finalize  {} | {}",
                    style("done").green().for_stderr(),
                    format_duration(elapsed)
                ));
                self.overall.set_message("");
            }
        }
    }

    fn finish(&self) {
        self.overall.finish_and_clear();
    }
}

fn format_eta(eta: Option<Duration>) -> String {
    eta.map(|eta| format!(" (ETA {})", format_clock(eta)))
        .unwrap_or_default()
}

fn format_clock(duration: Duration) -> String {
    let seconds = duration.as_secs();
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        format!("{:.1}s", duration.as_secs_f64())
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}
