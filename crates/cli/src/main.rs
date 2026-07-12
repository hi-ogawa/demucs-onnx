//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
//!
//! Usage:
//!   demucs separate --models <dir> [--name htdemucs|htdemucs_ft]
//!       [--two-stems <src>] [--method add|minus] [--shifts N] <input.wav> <out_dir>

use anyhow::{anyhow, bail, Context, Result};
use demucs_core as core;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::path::PathBuf;
use std::time::{Duration, Instant};

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
    let total_started = Instant::now();
    let args = parse_args(argv)?;
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

    let (members, bag) = core::vocab::select(&args.name, args.mode)?;
    let opts = core::Options {
        bag,
        shifts: args.shifts,
        mode: args.mode,
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

// Interactive layouts stay model-oriented while the overall row remains stable:
//   htdemucs.onnx | done Load | 5.2s
//   htdemucs.onnx | ...  Separate [======----] 11/17 chunks | elapsed 42s
//   Overall       | ...  [======----] 65% | ETA 23s | elapsed 42s
// Multi-model runs repeat the first two rows as Model 1/4, Model 2/4, and so on.
struct CliProgress {
    multi: MultiProgress,
    overall: ProgressBar,
    phase: Option<ProgressBar>,
    load_elapsed: Duration,
    inference_elapsed: Duration,
    finalize_elapsed: Duration,
    loaded: usize,
    eta: Option<Duration>,
    model_label: String,
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
            model_label: String::new(),
            model_chunks: 0,
        }
    }

    fn update(&mut self, event: ort_driver::Progress<'_>) {
        use ort_driver::Progress;
        match event {
            Progress::Started { total_chunks } => {
                self.overall.set_length(total_chunks as u64);
                self.overall.set_style(
                    ProgressStyle::with_template(
                        "{spinner} Overall [{bar:16}] {percent:>3}% | {pos}/{len} | {msg} | {elapsed_precise}",
                    )
                    .unwrap()
                    .progress_chars("=>-"),
                );
                self.overall.enable_steady_tick(Duration::from_millis(100));
            }
            Progress::LoadStarted {
                index,
                total,
                file,
                chunks,
            } => {
                self.model_label = if total == 1 {
                    file.to_string()
                } else {
                    format!("Model {index}/{total} {file}")
                };
                self.model_chunks = chunks;
                let phase = self.multi.insert_before(
                    &self.overall,
                    ProgressBar::new_spinner().with_prefix(self.model_label.clone()),
                );
                phase.set_style(
                    ProgressStyle::with_template("{prefix} | {spinner} Load | {elapsed_precise}")
                        .unwrap(),
                );
                phase.enable_steady_tick(Duration::from_millis(100));
                self.phase = Some(phase);
                self.overall.set_message(format!(
                    "loading model {index}/{total} | ETA {}",
                    format_eta(self.eta)
                ));
            }
            Progress::LoadFinished {
                index,
                total,
                elapsed,
            } => {
                self.load_elapsed += elapsed;
                self.loaded += 1;
                if let Some(phase) = self.phase.take() {
                    phase.set_style(
                        ProgressStyle::with_template("{prefix} | done Load | {msg}").unwrap(),
                    );
                    phase.finish_with_message(format_duration(elapsed));
                }
                let phase = self.multi.insert_before(
                    &self.overall,
                    ProgressBar::new(self.model_chunks as u64)
                        .with_prefix(self.model_label.clone()),
                );
                phase.set_style(
                    ProgressStyle::with_template(
                        "{prefix} | {spinner} Separate [{bar:16}] {percent:>3}% | {pos}/{len}{msg} | {elapsed_precise}",
                    )
                    .unwrap()
                    .progress_chars("=>-"),
                );
                phase.enable_steady_tick(Duration::from_millis(100));
                self.phase = Some(phase);
                self.overall.set_message(format!(
                    "starting model {index}/{total} | ETA {}",
                    format_eta(self.eta)
                ));
            }
            Progress::Inference {
                done,
                total,
                member,
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
                let context = if members == 1 {
                    "separating".to_string()
                } else {
                    format!("model {member}/{members}")
                };
                self.overall
                    .set_message(format!("{context} | ETA {}", format_eta(self.eta)));
            }
            Progress::MemberFinished {
                index,
                total,
                chunks,
                elapsed,
            } => {
                if let Some(phase) = self.phase.take() {
                    phase.set_style(
                        ProgressStyle::with_template(
                            "{prefix} | done Separate | {pos}/{len} chunks | {msg}",
                        )
                        .unwrap(),
                    );
                    phase.finish_with_message(format_duration(elapsed));
                }
                self.overall.set_message(format!(
                    "finished model {index}/{total} ({chunks} chunks) | ETA {}",
                    format_eta(self.eta)
                ));
            }
            Progress::FinalizeStarted => {
                let phase = self.multi.insert_before(
                    &self.overall,
                    ProgressBar::new_spinner().with_prefix("Stems"),
                );
                phase.set_style(
                    ProgressStyle::with_template(
                        "{prefix} | {spinner} Finalize | {elapsed_precise}",
                    )
                    .unwrap(),
                );
                phase.enable_steady_tick(Duration::from_millis(100));
                self.phase = Some(phase);
                self.overall.set_message("finalizing | ETA --");
            }
            Progress::FinalizeFinished { elapsed } => {
                self.finalize_elapsed = elapsed;
                if let Some(phase) = self.phase.take() {
                    phase.set_style(
                        ProgressStyle::with_template("{prefix} | done Finalize | {msg}").unwrap(),
                    );
                    phase.finish_with_message(format_duration(elapsed));
                }
                self.overall.set_message("complete | ETA 0.0s");
            }
        }
    }

    fn finish(&self) {
        self.overall.finish_and_clear();
    }
}

fn format_eta(eta: Option<Duration>) -> String {
    eta.map(format_duration).unwrap_or_else(|| "--".to_string())
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        format!("{:.1}s", duration.as_secs_f64())
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}
