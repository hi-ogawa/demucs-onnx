//! Browser binding and separation driver. Rust owns the algorithm loop; the JS host owns
//! browser I/O, notifications, and onnxruntime-web. Model tensors use views into staging
//! buffers in wasm linear memory, with one copy from ORT's output into the output buffer.
//!
//! Decode/resample remain the platform's job (decodeAudioData at 44.1k), so separation
//! takes raw per-channel f32.
//!
//! The browser interface uses wasm-bindgen while inference is delegated to onnxruntime-web.

use demucs_core as demucs;
use js_sys::{Float32Array, Promise};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

fn js_err(e: anyhow::Error) -> JsError {
    JsError::new(&format!("{e:#}"))
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "Host")]
    pub type Host;

    #[wasm_bindgen(method, structural, js_name = event)]
    fn started_event(this: &Host, kind: &str, total: usize);

    #[wasm_bindgen(method, structural, js_name = event)]
    fn model_event(this: &Host, kind: &str, index: usize, total: usize, chunks: usize, file: &str);

    #[wasm_bindgen(method, structural, js_name = event)]
    fn phase_event(this: &Host, kind: &str);

    #[wasm_bindgen(method, structural, js_name = event)]
    fn inference_event(
        this: &Host,
        kind: &str,
        done: usize,
        total: usize,
        member_done: usize,
        member_total: usize,
        shift: usize,
        shifts: usize,
    );

    #[wasm_bindgen(method, structural, catch, js_name = loadModel)]
    fn load_model(this: &Host, model: &str, source: Option<&str>) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, structural, catch, js_name = runModel)]
    fn run_model(
        this: &Host,
        session: &JsValue,
        input_ptr: usize,
        spectrogram_ptr: usize,
        frequency_ptr: usize,
        time_ptr: usize,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, structural, catch, js_name = releaseModel)]
    fn release_model(this: &Host, session: &JsValue) -> Result<Promise, JsValue>;
}

#[wasm_bindgen(typescript_custom_section)]
const HOST_TYPES: &str = r#"
export interface Host {
  event(...event:
    | [type: "started", total: number]
    | [type: "model-loading", index: number, total: number, chunks: number, file: string]
    | [type: "model-loaded" | "model-complete" | "finalizing" | "finalized"]
    | [type: "inference", done: number, total: number, memberDone: number, memberTotal: number, shift: number, shifts: number]
  ): void;
  loadModel(model: string, source?: string): Promise<unknown>;
  runModel(session: unknown, inputPtr: number, spectrogramPtr: number, frequencyPtr: number, timePtr: number): Promise<void>;
  releaseModel(session: unknown): Promise<void>;
}

"#;

/// Drive a complete browser separation. The host supplies all JS-only capabilities;
/// member/job ordering and output shaping live here.
#[wasm_bindgen]
pub async fn separate(
    model: &str,
    two_stems: Option<String>,
    method: Option<String>,
    shifts: u32,
    left: Vec<f32>,
    right: Vec<f32>,
    host: &Host,
) -> Result<Vec<Float32Array>, JsValue> {
    let mode = demucs::Mode::parse(two_stems.as_deref(), method.as_deref()).map_err(js_err)?;
    let (members, bag) = demucs::vocab::select(model, mode).map_err(js_err)?;
    let opts = demucs::Options { bag, shifts, mode };
    let mut separation = demucs::Separation::new([left, right], opts).map_err(js_err)?;
    let mut model_input = vec![0f32; demucs::CHANNELS * demucs::SEGMENT];
    let mut frequency = vec![
        0f32;
        demucs::NUM_SOURCES
            * demucs::dsp::CAC_CHANNELS
            * demucs::dsp::FREQUENCIES
            * demucs::dsp::FRAMES
    ];
    let mut time = vec![0f32; demucs::NUM_SOURCES * demucs::CHANNELS * demucs::SEGMENT];
    let mut stft = demucs::dsp::Stft::new();
    let mut istft = demucs::dsp::Istft::new();

    let total = separation.plan.total_chunks();
    host.started_event("started", total);
    let mut done = 0;
    for (member_index, member) in members.into_iter().enumerate() {
        let (member_model, source, file) = match member {
            demucs::vocab::Member::Htdemucs => ("htdemucs", None, "htdemucs.onnx"),
            demucs::vocab::Member::HtdemucsFt(source) => {
                let file = match source {
                    demucs::Source::Drums => "htdemucs_ft_drums.onnx",
                    demucs::Source::Bass => "htdemucs_ft_bass.onnx",
                    demucs::Source::Other => "htdemucs_ft_other.onnx",
                    demucs::Source::Vocals => "htdemucs_ft_vocals.onnx",
                };
                ("htdemucs_ft", Some(source.name()), file)
            }
        };
        let member_plan = &separation.plan.members[member_index];
        let member_total: usize = member_plan
            .shifts
            .iter()
            .map(|shift| shift.chunks.len())
            .sum();
        let mut member_done = 0;
        host.model_event(
            "model-loading",
            member_index + 1,
            separation.plan.members.len(),
            member_total,
            file,
        );
        let session = JsFuture::from(host.load_model(member_model, source)?).await?;
        host.phase_event("model-loaded");

        let mut shift_merger =
            demucs::ShiftMerger::new(separation.plan.track_len, member_plan.shifts.len());
        for (shift_index, shift) in member_plan.shifts.iter().enumerate() {
            let mut chunk_processor = separation.plan.create_chunk_processor(shift);
            for &chunk in &shift.chunks {
                chunk_processor
                    .prepare_input(chunk, &mut model_input)
                    .map_err(js_err)?;
                let spectrogram = stft.process(&model_input).map_err(js_err)?;
                JsFuture::from(host.run_model(
                    &session,
                    model_input.as_ptr() as usize,
                    spectrogram.as_ptr() as usize,
                    frequency.as_mut_ptr() as usize,
                    time.as_mut_ptr() as usize,
                )?)
                .await?;
                let mut output = istft.process(&frequency).map_err(js_err)?;
                for (sample, time_sample) in output.iter_mut().zip(&time) {
                    *sample += time_sample;
                }
                chunk_processor
                    .process_output(chunk, &output)
                    .map_err(js_err)?;
                done += 1;
                member_done += 1;
                host.inference_event(
                    "inference",
                    done,
                    total,
                    member_done,
                    member_total,
                    shift_index + 1,
                    member_plan.shifts.len(),
                );
            }
            shift_merger.add(chunk_processor.finish());
        }
        separation
            .stem_finalizer
            .add(member_index, shift_merger.finish());
        host.phase_event("model-complete");
        JsFuture::from(host.release_model(&session)?).await?;
    }

    host.phase_event("finalizing");
    let tracks: Vec<[Vec<f32>; demucs::CHANNELS]> =
        match separation.stem_finalizer.finish().map_err(js_err)? {
            demucs::Outputs::Full(stems) => stems.into(),
            demucs::Outputs::TwoStems {
                target, complement, ..
            } => vec![target, complement],
        };
    host.phase_event("finalized");
    Ok(tracks
        .iter()
        .flat_map(|track| {
            track
                .iter()
                .map(|channel| Float32Array::from(channel.as_slice()))
        })
        .collect())
}
