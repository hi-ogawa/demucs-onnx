//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};
use console::style;
use demucs_core as core;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use serde::Serialize;
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

    /// Separation model: standard (htdemucs) or fine-tuned (htdemucs_ft). Default: htdemucs
    #[arg(
        long,
        default_value = "htdemucs",
        value_name = "MODEL",
        value_parser = ["htdemucs", "htdemucs_ft"],
        hide_possible_values = true,
        hide_default_value = true
    )]
    name: String,

    /// Select a source and output it with a mix without it
    #[arg(
        long,
        value_name = "SOURCE",
        value_parser = ["drums", "bass", "other", "vocals"],
        hide_possible_values = true,
        long_help = "Select a SOURCE and output it with a mix without it. By default, output all four stems. Sources: drums, bass, vocals, or other (instruments not classified as vocals, drums, or bass)"
    )]
    two_stems: Option<String>,

    /// Choose the backing-mix quality and speed tradeoff
    #[arg(
        long,
        value_name = "MIX",
        value_parser = ["add", "minus"],
        hide_possible_values = true,
        long_help = "Choose the backing-mix quality and speed tradeoff: add combines the other separated stems; minus subtracts SOURCE from the original. With htdemucs_ft, minus runs about four times faster by using only that source's specialist. Results vary by track. Default: add"
    )]
    two_stems_mix: Option<String>,

    /// Trade speed for separation quality by averaging N passes
    #[arg(
        long,
        default_value_t = 1,
        value_name = "N",
        hide_default_value = true,
        long_help = "Trade speed for separation quality by averaging N processing passes. Runtime grows roughly in proportion. Default: 1"
    )]
    shifts: u32,

    /// ONNX Runtime intra-op threads; 0 uses the runtime default
    #[arg(long, default_value_t = 4, value_name = "N", hide_default_value = true)]
    threads: usize,

    /// Write machine-readable phase timings to this JSON file
    #[arg(long, value_name = "FILE")]
    timings_json: Option<PathBuf>,

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
    let mode = core::Mode::parse(args.two_stems.as_deref(), args.two_stems_mix.as_deref())?;
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
    let outputs = ort_driver::run_all(
        &args.models_dir,
        &members,
        wav,
        opts,
        args.threads,
        |event| progress.update(event),
    )?;
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
            ("backing".to_string(), complement),
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
    if let Some(path) = args.timings_json {
        let timings = Timings {
            prepare_ms: millis(prepare_elapsed),
            load_ms: millis(progress.load_elapsed),
            inference_ms: millis(progress.inference_elapsed),
            chunks: progress.chunks,
            finalize_ms: millis(progress.finalize_elapsed),
            write_ms: millis(write_elapsed),
            total_ms: millis(total_elapsed),
        };
        std::fs::write(&path, serde_json::to_vec_pretty(&timings)?)
            .with_context(|| format!("write {}", path.display()))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Timings {
    prepare_ms: f64,
    load_ms: f64,
    inference_ms: f64,
    chunks: Vec<ChunkTiming>,
    finalize_ms: f64,
    write_ms: f64,
    total_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkTiming {
    member: usize,
    shift: usize,
    chunk: usize,
    prepare_input_ms: f64,
    ort_run_ms: f64,
    output_copy_ms: f64,
    process_output_ms: f64,
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
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
    chunks: Vec<ChunkTiming>,
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
            chunks: Vec::new(),
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
                member,
                elapsed,
                prepare_elapsed,
                run_elapsed,
                process_elapsed,
            } => {
                self.inference_elapsed += elapsed;
                self.chunks.push(ChunkTiming {
                    member,
                    shift,
                    chunk: member_done,
                    prepare_input_ms: millis(prepare_elapsed),
                    ort_run_ms: millis(run_elapsed),
                    output_copy_ms: 0.0,
                    process_output_ms: millis(process_elapsed),
                });
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
