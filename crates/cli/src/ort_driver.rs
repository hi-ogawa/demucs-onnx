//! ONNX Runtime inference driver for the native CLI.

use anyhow::{anyhow, bail, Context, Result};
use demucs_core as core;
use std::path::Path;
use std::time::{Duration, Instant};

pub enum Progress<'a> {
    Started {
        total_chunks: usize,
    },
    LoadStarted {
        index: usize,
        total: usize,
        file: &'a str,
        chunks: usize,
    },
    LoadFinished {
        elapsed: Duration,
    },
    Inference {
        done: usize,
        total: usize,
        members: usize,
        shift: usize,
        shifts: usize,
        member_done: usize,
        elapsed: Duration,
    },
    MemberFinished {
        chunks: usize,
        elapsed: Duration,
    },
    FinalizeStarted,
    FinalizeFinished {
        elapsed: Duration,
    },
}

#[derive(Clone, Copy, Debug)]
pub enum GraphFlavor {
    Auto,
    Legacy,
    Split,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoadedGraph {
    Legacy,
    Split,
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

pub fn run_all(
    models_dir: &Path,
    graph_flavor: GraphFlavor,
    members: &[core::vocab::Member],
    wav: [Vec<f32>; core::CHANNELS],
    opts: core::Options,
    mut on_progress: impl FnMut(Progress<'_>),
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
    on_progress(Progress::Started {
        total_chunks: total,
    });
    let mut done = 0;
    let mut input = vec![0f32; core::CHANNELS * core::SEGMENT];
    let mut stft = core::dsp::Stft::new();
    let mut istft = core::dsp::Istft::new();
    for (member_index, &member) in members.iter().enumerate() {
        let member_plan = &separation.plan.members[member_index];
        let member_total = member_plan
            .shifts
            .iter()
            .map(|shift| shift.chunks.len())
            .sum();
        let mut member_done = 0;
        let file = member_file(member);
        on_progress(Progress::LoadStarted {
            index: member_index + 1,
            total: members.len(),
            file,
            chunks: member_total,
        });
        let path = models_dir.join(file);
        let load_started = Instant::now();
        let mut session = ort::session::Session::builder()
            .map_err(ort_err)?
            .with_intra_threads(4)
            .map_err(ort_err)?
            .commit_from_file(&path)
            .map_err(ort_err)
            .with_context(|| format!("load {}", path.display()))?;
        let loaded_graph = graph_contract(&session, graph_flavor)?;
        on_progress(Progress::LoadFinished {
            elapsed: load_started.elapsed(),
        });
        let inference_started = Instant::now();
        let mut shift_merger =
            core::ShiftMerger::new(separation.plan.track_len, member_plan.shifts.len());
        for (shift_index, shift) in member_plan.shifts.iter().enumerate() {
            let mut chunk_processor = separation.plan.create_chunk_processor(shift);
            for &chunk in &shift.chunks {
                let chunk_started = Instant::now();
                chunk_processor.prepare_input(chunk, &mut input)?;
                let value = ort::value::TensorRef::from_array_view((
                    [1usize, core::CHANNELS, core::SEGMENT],
                    input.as_slice(),
                ))
                .map_err(ort_err)?;
                match loaded_graph {
                    LoadedGraph::Legacy => {
                        let run = session
                            .run(ort::inputs!["input" => value])
                            .map_err(ort_err)?;
                        let (shape, data) =
                            run["output"].try_extract_tensor::<f32>().map_err(ort_err)?;
                        let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
                        if dims != [1, core::NUM_SOURCES, core::CHANNELS, core::SEGMENT] {
                            bail!("unexpected output shape {dims:?}");
                        }
                        chunk_processor.process_output(chunk, data)?;
                    }
                    LoadedGraph::Split => {
                        let spectrogram = stft.process(&input)?;
                        let spectrogram_value = ort::value::TensorRef::from_array_view((
                            [
                                1usize,
                                core::dsp::CAC_CHANNELS,
                                core::dsp::FREQUENCIES,
                                core::dsp::FRAMES,
                            ],
                            spectrogram.as_slice(),
                        ))
                        .map_err(ort_err)?;
                        let run = session
                            .run(ort::inputs![
                                "waveform" => value,
                                "spectrogram" => spectrogram_value,
                            ])
                            .map_err(ort_err)?;
                        let (frequency_shape, frequency) = run["frequency"]
                            .try_extract_tensor::<f32>()
                            .map_err(ort_err)?;
                        let frequency_dims: Vec<usize> =
                            frequency_shape.iter().map(|&d| d as usize).collect();
                        if frequency_dims
                            != [
                                1,
                                core::NUM_SOURCES,
                                core::dsp::CAC_CHANNELS,
                                core::dsp::FREQUENCIES,
                                core::dsp::FRAMES,
                            ]
                        {
                            bail!("unexpected frequency output shape {frequency_dims:?}");
                        }
                        let (time_shape, time) =
                            run["time"].try_extract_tensor::<f32>().map_err(ort_err)?;
                        let time_dims: Vec<usize> =
                            time_shape.iter().map(|&d| d as usize).collect();
                        if time_dims != [1, core::NUM_SOURCES, core::CHANNELS, core::SEGMENT] {
                            bail!("unexpected time output shape {time_dims:?}");
                        }
                        let mut output = istft.process(frequency)?;
                        for (sample, time_sample) in output.iter_mut().zip(time) {
                            *sample += time_sample;
                        }
                        chunk_processor.process_output(chunk, &output)?;
                    }
                }
                done += 1;
                member_done += 1;
                on_progress(Progress::Inference {
                    done,
                    total,
                    members: members.len(),
                    shift: shift_index + 1,
                    shifts: member_plan.shifts.len(),
                    member_done,
                    elapsed: chunk_started.elapsed(),
                });
            }
            shift_merger.add(chunk_processor.finish());
        }
        separation
            .stem_finalizer
            .add(member_index, shift_merger.finish());
        on_progress(Progress::MemberFinished {
            chunks: member_total,
            elapsed: inference_started.elapsed(),
        });
    }
    on_progress(Progress::FinalizeStarted);
    let finalize_started = Instant::now();
    let outputs = separation.stem_finalizer.finish()?;
    on_progress(Progress::FinalizeFinished {
        elapsed: finalize_started.elapsed(),
    });
    Ok(outputs)
}

fn graph_contract(session: &ort::session::Session, requested: GraphFlavor) -> Result<LoadedGraph> {
    let inputs: Vec<&str> = session.inputs().iter().map(|input| input.name()).collect();
    let outputs: Vec<&str> = session
        .outputs()
        .iter()
        .map(|output| output.name())
        .collect();
    let loaded = match (inputs.as_slice(), outputs.as_slice()) {
        (["input"], ["output"]) => LoadedGraph::Legacy,
        (["waveform", "spectrogram"], ["frequency", "time"]) => LoadedGraph::Split,
        _ => bail!("unsupported ONNX contract: inputs {inputs:?}, outputs {outputs:?}"),
    };
    match requested {
        GraphFlavor::Auto => Ok(loaded),
        GraphFlavor::Legacy if loaded == LoadedGraph::Legacy => Ok(loaded),
        GraphFlavor::Split if loaded == LoadedGraph::Split => Ok(loaded),
        _ => bail!("requested {requested:?} graph but loaded {loaded:?}"),
    }
}
