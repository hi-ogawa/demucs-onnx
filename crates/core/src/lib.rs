//! demucs-core: the sans-inference orchestration layer of the demucs port.
//!
//! Owns everything except running the neural net: global loudness normalization, the shift
//! trick (deterministic seeded offsets), fixed-size chunking with centered padding,
//! triangular weighted overlap-add, bag member selection, and two-stems arithmetic
//! ([`engine`]), plus channel conform ([`audio`]) and, behind default features, a wav
//! byte codec (`wav`) and sinc resampling (`resample`) — the wasm tier disables both
//! because the browser decodes and resamples natively. Core never touches the
//! filesystem; drivers own where bytes live.
//!
//! Inference and reducer lifecycle are the caller's job. The plan explicitly nests
//! members, shifts, and chunks; core supplies scoped overlap-add, shift merge, and stem
//! finalization components.
//!
//! ```ignore
//! let mut separation = Separation::new(wav, opts)?;
//! let mut buf = vec![0f32; CHANNELS * SEGMENT];
//! for (member_index, member) in separation.plan.members.iter().enumerate() {
//!     let model = load_model(member_index);
//!     let mut shift_merger = ShiftMerger::new(separation.plan.track_len, member.shifts.len());
//!     for shift in &member.shifts {
//!         let mut chunk_processor = separation.plan.create_chunk_processor(shift);
//!         for &chunk in &shift.chunks {
//!             chunk_processor.prepare_input(chunk, &mut buf)?;
//!             chunk_processor.process_output(chunk, model.run(&buf)?)?;
//!         }
//!         shift_merger.add(chunk_processor.finish());
//!     }
//!     separation.stem_finalizer.add(member_index, shift_merger.finish());
//! }
//! let stems = separation.stem_finalizer.finish()?;
//! ```
//!
//! Mirrors upstream demucs math (api.py Separator + apply.py apply_model); deliberate
//! divergences: seeded deterministic shift offsets, and no output rescale-on-clip (raw f32
//! preserves stems-sum-to-mix).

mod audio;
mod engine;
pub mod vocab;
#[cfg(feature = "wav")]
mod wav;

pub use audio::conform_channels;
#[cfg(feature = "resample")]
pub use audio::resample;
pub use engine::{
    Bag, Chunk, ChunkStrideProcessor, MemberEstimate, MemberPlan, Mode, Options, Plan, Separation,
    ShiftEstimate, ShiftMerger, ShiftPlan, StemFinalizer,
};
#[cfg(feature = "wav")]
pub use wav::{decode_wav, encode_wav};

// The black-box i/o contract, shared with drivers (tensor shapes, buffer sizes).
pub const SAMPLERATE: u32 = 44100;
pub const CHANNELS: usize = 2;
pub const NUM_SOURCES: usize = 4;
pub const SEGMENT: usize = 343980; // 7.8s * 44100, fixed by the exported graph

// Audio buffers are f32 with one Vec per channel ("planar", as opposed to a wav file's
// interleaved LRLR frames): a stereo track is [Vec<f32>; CHANNELS], i.e. two mono buffers,
// matching the model tensor (1, CHANNELS, samples) and the browser's getChannelData.
// Only wav reading deals in arbitrary channel counts (Vec<Vec<f32>>, before conform).

/// The four demucs sources, in the model's output-row order. The engine is purely
/// positional; naming and parsing live in [`vocab`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Drums,
    Bass,
    Other,
    Vocals,
}

impl Source {
    pub const ALL: [Source; NUM_SOURCES] =
        [Source::Drums, Source::Bass, Source::Other, Source::Vocals];

    /// Row index on the output's stem axis.
    pub fn index(self) -> usize {
        self as usize
    }
}

/// What a separation yields, exactly; each track is stereo, `[channel][sample]`.
/// How tracks are spelled (e.g. `backing.wav`) is the driver's concern.
pub enum Outputs {
    /// All four stems, in [`Source::ALL`] order.
    Full([[Vec<f32>; CHANNELS]; NUM_SOURCES]),
    /// Two-stems mode: the target and everything-but-the-target.
    TwoStems {
        source: Source,
        target: [Vec<f32>; CHANNELS],
        complement: [Vec<f32>; CHANNELS],
    },
}
