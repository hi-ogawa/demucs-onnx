//! Browser binding and separation driver. Rust owns the algorithm loop; the JS host owns
//! browser I/O, notifications, and onnxruntime-web. Model tensors use views into staging
//! buffers in wasm linear memory, with one copy from ORT's output into the output buffer.
//!
//! Decode/resample remain the platform's job (decodeAudioData at 44.1k), so separation
//! takes raw per-channel f32.
//!
//! Note: prototype uses wasm-bindgen rather than the napi-rs wasm target (emnapi) — the napi
//! crate depends on ort, which doesn't compile to wasm; unification is a later concern.

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
    fn progress_event(this: &Host, kind: &str, done: usize, total: usize);

    #[wasm_bindgen(method, structural, catch)]
    fn initialize(this: &Host) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, structural, catch, js_name = loadModel)]
    fn load_model(this: &Host, model: &str, source: Option<&str>) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, structural, catch, js_name = runModel)]
    fn run_model(
        this: &Host,
        session: &JsValue,
        input_ptr: usize,
        output_ptr: usize,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, structural, catch, js_name = releaseModel)]
    fn release_model(this: &Host, session: &JsValue) -> Result<Promise, JsValue>;
}

#[wasm_bindgen(typescript_custom_section)]
const HOST_TYPES: &str = r#"
export interface Host {
  event(...event: [type: "status", text: string] | [type: "progress", done: number, total: number]): void;
  initialize(): Promise<void>;
  loadModel(model: string, source?: string): Promise<unknown>;
  runModel(session: unknown, inputPtr: number, outputPtr: number): Promise<void>;
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
    let mut output = vec![0f32; demucs::NUM_SOURCES * demucs::CHANNELS * demucs::SEGMENT];

    JsFuture::from(host.initialize()?).await?;

    let total = separation.plan.total_chunks();
    let mut done = 0;
    for (member_index, member) in members.into_iter().enumerate() {
        let (member_model, source) = match member {
            demucs::vocab::Member::Htdemucs => ("htdemucs", None),
            demucs::vocab::Member::HtdemucsFt(source) => ("htdemucs_ft", Some(source.name())),
        };
        let session = JsFuture::from(host.load_model(member_model, source)?).await?;

        let member_plan = &separation.plan.members[member_index];
        let mut shift_merger =
            demucs::ShiftMerger::new(separation.plan.track_len, member_plan.shifts.len());
        for shift in &member_plan.shifts {
            let mut chunk_processor = separation.plan.create_chunk_processor(shift);
            for &chunk in &shift.chunks {
                chunk_processor
                    .prepare_input(chunk, &mut model_input)
                    .map_err(js_err)?;
                JsFuture::from(host.run_model(
                    &session,
                    model_input.as_ptr() as usize,
                    output.as_mut_ptr() as usize,
                )?)
                .await?;
                chunk_processor
                    .process_output(chunk, &output)
                    .map_err(js_err)?;
                done += 1;
                host.progress_event("progress", done, total);
            }
            shift_merger.add(chunk_processor.finish());
        }
        separation
            .stem_finalizer
            .add(member_index, shift_merger.finish());
        JsFuture::from(host.release_model(&session)?).await?;
    }

    let tracks: Vec<[Vec<f32>; demucs::CHANNELS]> =
        match separation.stem_finalizer.finish().map_err(js_err)? {
            demucs::Outputs::Full(stems) => stems.into(),
            demucs::Outputs::TwoStems {
                target, complement, ..
            } => vec![target, complement],
        };
    Ok(tracks
        .iter()
        .flat_map(|track| {
            track
                .iter()
                .map(|channel| Float32Array::from(channel.as_slice()))
        })
        .collect())
}
