//! ONNX Runtime inference driver for the native CLI.

use anyhow::{anyhow, bail, Context, Result};
use demucs_core as core;
use std::path::Path;

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
