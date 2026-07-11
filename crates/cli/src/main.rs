//! demucs CLI: ONNX Runtime-backed driver over demucs-core's separation engine.
//!
//! Usage:
//!   demucs separate --models <dir> [--name htdemucs|htdemucs_ft]
//!       [--two-stems <src>] [--method add|minus] [--shifts N] <input.wav> <out_dir>

use anyhow::{anyhow, bail, Context, Result};
use demucs_core as core;
use std::path::{Path, PathBuf};

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
    let outputs = run_all(
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

fn ort_err<R>(e: ort::Error<R>) -> anyhow::Error {
    anyhow!("ort: {e}")
}

fn member_file(member: core::vocab::Member) -> &'static str {
    use core::vocab::Member;
    match member {
        Member::Htdemucs => "htdemucs.onnx",
        Member::HtdemucsFt(core::Source::Drums) => "htdemucs_ft_drums.onnx",
        Member::HtdemucsFt(core::Source::Bass) => "htdemucs_ft_bass.onnx",
        Member::HtdemucsFt(core::Source::Other) => "htdemucs_ft_other.onnx",
        Member::HtdemucsFt(core::Source::Vocals) => "htdemucs_ft_vocals.onnx",
    }
}

fn run_all(
    models_dir: &Path,
    members: &[core::vocab::Member],
    wav: [Vec<f32>; core::CHANNELS],
    opts: core::Options,
    mut on_member: impl FnMut(&str),
    mut on_progress: impl FnMut(usize, usize),
) -> Result<core::Outputs> {
    let mut separation = core::Separation::new(wav, opts)?;
    if members.len() != separation.plan.members.len() {
        bail!(
            "{} models for {} bag members",
            members.len(),
            separation.plan.members.len()
        );
    }
    let total = separation.plan.total_chunks();
    let mut done = 0;
    let mut input = vec![0f32; core::CHANNELS * core::SEGMENT];
    for (member_index, &member) in members.iter().enumerate() {
        let member_plan = &separation.plan.members[member_index];
        let file = member_file(member);
        on_member(file);
        let path = models_dir.join(file);
        let mut session = ort::session::Session::builder()
            .map_err(ort_err)?
            .with_intra_threads(4)
            .map_err(ort_err)?
            .commit_from_file(&path)
            .map_err(ort_err)
            .with_context(|| format!("load {}", path.display()))?;
        let mut shift_merger =
            core::ShiftMerger::new(separation.plan.track_len, member_plan.shifts.len());
        for shift in &member_plan.shifts {
            let mut chunk_processor = separation.plan.create_chunk_processor(shift);
            for &chunk in &shift.chunks {
                chunk_processor.prepare_input(chunk, &mut input)?;
                let value = ort::value::TensorRef::from_array_view((
                    [1usize, core::CHANNELS, core::SEGMENT],
                    input.as_slice(),
                ))
                .map_err(ort_err)?;
                let run = session
                    .run(ort::inputs!["input" => value])
                    .map_err(ort_err)?;
                let (shape, data) = run["output"].try_extract_tensor::<f32>().map_err(ort_err)?;
                let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                if dims != [1, core::NUM_SOURCES, core::CHANNELS, core::SEGMENT] {
                    bail!("unexpected output shape {dims:?}");
                }
                chunk_processor.process_output(chunk, data)?;
                done += 1;
                on_progress(done, total);
            }
            shift_merger.add(chunk_processor.finish());
        }
        separation
            .stem_finalizer
            .add(member_index, shift_merger.finish());
    }
    separation.stem_finalizer.finish()
}
