//! The separation engine: normalization, shift trick, chunking, weighted overlap-add,
//! bag weighting, two-stems arithmetic. Purely positional — no names, no files.

use crate::{Outputs, Source, CHANNELS, NUM_SOURCES, SAMPLERATE, SEGMENT};
use anyhow::{bail, Result};

// Chunking / shift-trick parameters, mirroring upstream apply.py defaults.
const OVERLAP: f64 = 0.25;
const MAX_SHIFT: usize = SAMPLERATE as usize / 2; // 0.5s, upstream shift trick bound
const SHIFT_SEED: u64 = 42;

/// How the bag's member runs map to output stems — the three shapes the product ships.
/// (Upstream's general form is a fractional weighted average across members; none of our
/// configs use it, so the engine encodes only these.)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bag {
    /// One member run; all four stems are taken from it.
    AllFromOne,
    /// One member run per stem, in [`Source::ALL`] order; member `i` keeps only stem `i`.
    PerStem,
    /// One member run; only this stem is kept (the minus-mode fast path).
    Single(Source),
}

impl Bag {
    pub fn member_count(self) -> usize {
        match self {
            Bag::AllFromOne | Bag::Single(_) => 1,
            Bag::PerStem => NUM_SOURCES,
        }
    }

    /// Is stem `s` taken from member `member`?
    fn keeps(self, member: usize, s: usize) -> bool {
        match self {
            Bag::AllFromOne => true,
            Bag::PerStem => member == s,
            Bag::Single(src) => s == src.index(),
        }
    }

    /// Does any member produce stem `s`?
    fn covers(self, s: usize) -> bool {
        match self {
            Bag::AllFromOne | Bag::PerStem => true,
            Bag::Single(src) => s == src.index(),
        }
    }
}

/// The requested output shape.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// All four stems.
    Full,
    /// Two stems: the target plus a complement summed from the other three.
    Add(Source),
    /// Two stems: the target plus a complement of mix minus target.
    Minus(Source),
}

#[derive(Clone, Debug)]
pub struct Options {
    pub bag: Bag,
    /// Number of averaged passes: 1 is a single plain pass, N >= 2 averages N
    /// seeded-offset passes (upstream's shift trick, N x compute). 0 is rejected.
    /// (Divergence from upstream's flag, where 1 means one randomly shifted pass —
    /// offsetting a single pass buys nothing.)
    pub shifts: u32,
    pub mode: Mode,
}

impl Options {
    /// Which stems the requested output needs: minus two-stems needs only the target;
    /// everything else (full mode, add two-stems) needs all four.
    fn needs(&self, s: usize) -> bool {
        match self.mode {
            Mode::Minus(src) => s == src.index(),
            _ => true,
        }
    }
}

/// One fixed-size model invocation within a shifted view.
#[derive(Clone, Copy, Debug)]
pub struct Chunk {
    pub offset: usize,
    pub len: usize,
}

impl Chunk {
    fn center_pad(self) -> usize {
        (SEGMENT - self.len) / 2
    }
}

/// One shifted view, reduced from its chunks by a [`ChunkStrideProcessor`].
#[derive(Debug)]
pub struct ShiftPlan {
    pub offset: usize,
    pub len: usize,
    pub chunks: Vec<Chunk>,
}

/// All shifted passes for one bag member.
#[derive(Debug)]
pub struct MemberPlan {
    pub shifts: Vec<ShiftPlan>,
}

/// The caller-owned loop shape: member, then shift, then chunk.
#[derive(Debug)]
pub struct Plan {
    pub track_len: usize,
    pub members: Vec<MemberPlan>,
    shifted: bool,
    norm: [Vec<f32>; CHANNELS],
    triangle_weight: Vec<f32>,
}

impl Plan {
    pub fn total_chunks(&self) -> usize {
        self.members
            .iter()
            .flat_map(|member| &member.shifts)
            .map(|shift| shift.chunks.len())
            .sum()
    }

    pub fn create_chunk_processor<'a>(&'a self, shift: &ShiftPlan) -> ChunkStrideProcessor<'a> {
        ChunkStrideProcessor {
            plan: self,
            shift_offset: shift.offset,
            ola: empty_stems(shift.len),
            ola_weight: vec![0.; shift.len],
        }
    }
}

/// Constructed separation parts. The caller owns their lifecycle and drives the plan.
pub struct Separation {
    pub plan: Plan,
    pub stem_finalizer: StemFinalizer,
}

impl Separation {
    /// `wav`: conformed 44.1k stereo audio, one buffer per channel
    /// (use `conform_channels` + `resample`).
    pub fn new(wav: [Vec<f32>; CHANNELS], opts: Options) -> Result<Self> {
        if wav[0].is_empty() || wav.iter().any(|ch| ch.len() != wav[0].len()) {
            bail!("expected non-empty channels of equal length");
        }
        if opts.shifts == 0 {
            bail!("shifts must be >= 1 (1 = single pass, 2+ = averaged shifted passes)");
        }
        for s in 0..NUM_SOURCES {
            if opts.needs(s) && !opts.bag.covers(s) {
                bail!(
                    "bag {:?} does not produce stem {s}, which the output needs",
                    opts.bag
                );
            }
        }
        let length = wav[0].len();
        let (mean, std) = ref_stats(&wav);
        let norm: [Vec<f32>; CHANNELS] =
            std::array::from_fn(|ch| wav[ch].iter().map(|&s| normalize(s, mean, std)).collect());

        // Deterministic plan: member-major, shift, then chunk offsets. Shift offsets come
        // from a seeded xorshift drawn in this exact order (reproducible runs).
        let stride = ((1.0 - OVERLAP) * SEGMENT as f64) as usize;
        let mut members = Vec::with_capacity(opts.bag.member_count());
        let mut rng = SHIFT_SEED;
        for _ in 0..opts.bag.member_count() {
            let mut shifts = Vec::with_capacity(opts.shifts as usize);
            for _ in 0..opts.shifts {
                let (shift_offset, sub_len) = if opts.shifts == 1 {
                    (0, length)
                } else {
                    let off = (xorshift64(&mut rng) % MAX_SHIFT as u64) as usize;
                    (off, length + MAX_SHIFT - off)
                };
                let mut offset = 0;
                let mut chunks = Vec::new();
                while offset < sub_len {
                    chunks.push(Chunk {
                        offset,
                        len: SEGMENT.min(sub_len - offset),
                    });
                    offset += stride;
                }
                shifts.push(ShiftPlan {
                    offset: shift_offset,
                    len: sub_len,
                    chunks,
                });
            }
            members.push(MemberPlan { shifts });
        }

        Ok(Separation {
            plan: Plan {
                track_len: length,
                members,
                shifted: opts.shifts >= 2,
                norm,
                triangle_weight: triangle_weight(),
            },
            stem_finalizer: StemFinalizer {
                opts,
                length,
                mean,
                std,
                wav,
                stems: empty_stems(length),
            },
        })
    }
}

/// Weighted overlap-add for exactly one shifted view.
pub struct ChunkStrideProcessor<'a> {
    plan: &'a Plan,
    shift_offset: usize,
    ola: [[Vec<f32>; CHANNELS]; NUM_SOURCES],
    ola_weight: Vec<f32>,
}

impl ChunkStrideProcessor<'_> {
    /// Materialize a chunk as flattened `(1, CHANNELS, SEGMENT)` model input.
    pub fn prepare_input(&self, chunk: Chunk, buf: &mut [f32]) -> Result<()> {
        if buf.len() != CHANNELS * SEGMENT {
            bail!(
                "expected input buffer of {} floats, got {}",
                CHANNELS * SEGMENT,
                buf.len()
            );
        }
        buf.fill(0.);
        let mut start = chunk.offset as i64 - chunk.center_pad() as i64;
        if self.plan.shifted {
            start += self.shift_offset as i64 - MAX_SHIFT as i64;
        }
        let track_len = self.plan.track_len;
        // input[ch, i] = norm[ch, start + i] inside the track, otherwise zero.
        for ch in 0..CHANNELS {
            for i in 0..SEGMENT {
                let idx = start + i as i64;
                if idx >= 0 && (idx as usize) < track_len {
                    buf[ch * SEGMENT + i] = self.plan.norm[ch][idx as usize];
                }
            }
        }
        Ok(())
    }

    /// Add one flattened `(1, NUM_SOURCES, CHANNELS, SEGMENT)` model output.
    pub fn process_output(&mut self, chunk: Chunk, output: &[f32]) -> Result<()> {
        if output.len() != NUM_SOURCES * CHANNELS * SEGMENT {
            bail!(
                "expected output of {} floats, got {}",
                NUM_SOURCES * CHANNELS * SEGMENT,
                output.len()
            );
        }

        overlap_add(
            &mut self.ola,
            &mut self.ola_weight,
            &self.plan.triangle_weight,
            output,
            chunk.offset,
            chunk.len,
            chunk.center_pad(),
        );
        Ok(())
    }

    pub fn finish(mut self) -> ShiftEstimate {
        // ola[source, channel, :] /= ola_weight[:].
        for stem in &mut self.ola {
            for channel in stem {
                for (sample, weight) in channel.iter_mut().zip(&self.ola_weight) {
                    *sample /= weight;
                }
            }
        }
        ShiftEstimate { stems: self.ola }
    }
}

/// One completed shifted view, ready to merge into a member estimate.
pub struct ShiftEstimate {
    stems: [[Vec<f32>; CHANNELS]; NUM_SOURCES],
}

/// Merge completed shifted views for one bag member.
pub struct ShiftMerger {
    track_len: usize,
    shift_count: f32,
    acc: [[Vec<f32>; CHANNELS]; NUM_SOURCES],
}

impl ShiftMerger {
    pub fn new(track_len: usize, shift_count: usize) -> Self {
        ShiftMerger {
            track_len,
            shift_count: shift_count as f32,
            acc: empty_stems(track_len),
        }
    }

    pub fn add(&mut self, shift: ShiftEstimate) {
        let skip = shift.stems[0][0].len() - self.track_len;
        // acc[:, :, :] += shift[:, :, skip..skip + length].
        for (acc_stem, shift_stem) in self.acc.iter_mut().zip(shift.stems) {
            for (acc_channel, shift_channel) in acc_stem.iter_mut().zip(shift_stem) {
                for i in 0..self.track_len {
                    acc_channel[i] += shift_channel[skip + i];
                }
            }
        }
    }

    pub fn finish(mut self) -> MemberEstimate {
        // acc[:, :, :] /= number_of_shift_runs.
        for stem in &mut self.acc {
            for channel in stem {
                for sample in channel {
                    *sample /= self.shift_count;
                }
            }
        }
        MemberEstimate(self.acc)
    }
}

pub struct MemberEstimate([[Vec<f32>; CHANNELS]; NUM_SOURCES]);

/// Select member stems, restore loudness, and produce the requested output shape.
pub struct StemFinalizer {
    opts: Options,
    length: usize,
    mean: f64,
    std: f64,
    wav: [Vec<f32>; CHANNELS],
    stems: [[Vec<f32>; CHANNELS]; NUM_SOURCES],
}

impl StemFinalizer {
    pub fn add(&mut self, member: usize, estimate: MemberEstimate) {
        for (s, stem) in estimate.0.into_iter().enumerate() {
            if self.opts.bag.keeps(member, s) {
                self.stems[s] = stem;
            }
        }
    }

    pub fn finish(mut self) -> Result<Outputs> {
        for s in 0..NUM_SOURCES {
            if !self.opts.bag.covers(s) {
                continue; // uncovered stems stay zero (and are unused by the output mode)
            }
            for ch in 0..CHANNELS {
                for i in 0..self.length {
                    self.stems[s][ch][i] = denormalize(self.stems[s][ch][i], self.mean, self.std);
                }
            }
        }

        let (source, complement) = match self.opts.mode {
            Mode::Full => return Ok(Outputs::Full(self.stems)),
            Mode::Add(src) => {
                let mut rest: [Vec<f32>; CHANNELS] =
                    std::array::from_fn(|_| vec![0f32; self.length]);
                for (s, stem) in self.stems.iter().enumerate() {
                    if s == src.index() {
                        continue;
                    }
                    for ch in 0..CHANNELS {
                        for i in 0..self.length {
                            rest[ch][i] += stem[ch][i];
                        }
                    }
                }
                (src, rest)
            }
            Mode::Minus(src) => {
                let target = &self.stems[src.index()];
                let rest: [Vec<f32>; CHANNELS] = std::array::from_fn(|ch| {
                    (0..self.length)
                        .map(|i| self.wav[ch][i] - target[ch][i])
                        .collect()
                });
                (src, rest)
            }
        };
        let target = std::mem::take(&mut self.stems[source.index()]);
        Ok(Outputs::TwoStems {
            source,
            target,
            complement,
        })
    }
}

/// Zeroed `[stem][channel][sample]` accumulator.
fn empty_stems(len: usize) -> [[Vec<f32>; CHANNELS]; NUM_SOURCES] {
    std::array::from_fn(|_| std::array::from_fn(|_| vec![0f32; len]))
}

/// Z-score a sample against the mix's reference stats (upstream's 1e-8 epsilon).
fn normalize(sample: f32, mean: f64, std: f64) -> f32 {
    ((sample as f64 - mean) / (std + 1e-8)) as f32
}

/// Invert [`normalize`]: restore a sample to the mix's loudness.
fn denormalize(sample: f32, mean: f64, std: f64) -> f32 {
    (sample as f64 * (std + 1e-8) + mean) as f32
}

/// One xorshift64 step (13/7/17 triple): the seeded generator behind the shift trick's
/// deterministic offsets.
fn xorshift64(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

/// Weighted overlap-add: skip `trim_left` samples of the model output (centered padding),
/// then accumulate `chunk_len` weighted samples (and the weight itself) into the OLA
/// buffers at `offset`. `output` is flattened `(1, NUM_SOURCES, CHANNELS, SEGMENT)`.
fn overlap_add(
    ola: &mut [[Vec<f32>; CHANNELS]; NUM_SOURCES],
    ola_weight: &mut [f32],
    weight: &[f32],
    output: &[f32],
    offset: usize,
    chunk_len: usize,
    trim_left: usize,
) {
    // ola[s, ch, offset + i] += weight[i] * output[s, ch, trim_left + i].
    for (source, stem) in ola.iter_mut().enumerate() {
        for (channel, acc) in stem.iter_mut().enumerate() {
            let base = (source * CHANNELS + channel) * SEGMENT;
            for i in 0..chunk_len {
                acc[offset + i] += weight[i] * output[base + trim_left + i];
            }
        }
    }
    // ola_weight[offset + i] += weight[i].
    for i in 0..chunk_len {
        ola_weight[offset + i] += weight[i];
    }
}

/// Mean and sample std (Bessel-corrected, matching torch .std()) of the mono fold-down.
fn ref_stats(wav: &[Vec<f32>]) -> (f64, f64) {
    let n = wav[0].len();
    let mono: Vec<f64> = (0..n)
        .map(|i| wav.iter().map(|ch| ch[i] as f64).sum::<f64>() / CHANNELS as f64)
        .collect();
    let mean = mono.iter().sum::<f64>() / n as f64;
    let var = mono.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0);
    (mean, var.sqrt())
}

/// Triangular overlap-add weight, normalized to max 1 (transition_power=1).
fn triangle_weight() -> Vec<f32> {
    let half = SEGMENT / 2;
    let mut w: Vec<f32> = (1..=half)
        .chain((1..=(SEGMENT - half)).rev())
        .map(|v| v as f32)
        .collect();
    let max = w[half - 1];
    for v in &mut w {
        *v /= max;
    }
    w
}
