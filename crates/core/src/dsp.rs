//! Runtime spectral preprocessing for split-DSP HTDemucs models.

use anyhow::{bail, Result};
use realfft::{num_complex::Complex32, RealFftPlanner, RealToComplex};
use std::sync::Arc;

use crate::{CHANNELS, SEGMENT};

pub const N_FFT: usize = 4096;
pub const HOP_LENGTH: usize = 1024;
pub const FREQUENCIES: usize = 2048;
pub const FRAMES: usize = 336;
pub const CAC_CHANNELS: usize = CHANNELS * 2;

const ALIGNMENT_PAD: usize = 3 * HOP_LENGTH / 2;
const ALIGNED_LENGTH: usize = FRAMES * HOP_LENGTH;

/// Reusable FFT state for producing the ONNX graph's packed spectrogram input.
pub struct Stft {
    forward: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    output: Vec<Complex32>,
}

impl Stft {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(N_FFT);
        let input = forward.make_input_vec();
        let output = forward.make_output_vec();
        let window = (0..N_FFT)
            .map(|index| {
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / N_FFT as f32).cos()
            })
            .collect();
        Self {
            forward,
            window,
            input,
            output,
        }
    }

    /// Convert planar stereo `[channel][sample]` into flattened
    /// `[1, left-real/imag, right-real/imag, frequency, frame]` data.
    pub fn process(&mut self, waveform: &[Vec<f32>; CHANNELS]) -> Result<Vec<f32>> {
        if waveform.iter().any(|channel| channel.len() != SEGMENT) {
            bail!("STFT requires {CHANNELS} channels of {SEGMENT} samples");
        }

        let mut packed = vec![0.0; CAC_CHANNELS * FREQUENCIES * FRAMES];
        for (channel_index, channel) in waveform.iter().enumerate() {
            let aligned = reflect_pad(
                channel,
                ALIGNMENT_PAD,
                ALIGNMENT_PAD + ALIGNED_LENGTH - SEGMENT,
            );
            let centered = reflect_pad(&aligned, N_FFT / 2, N_FFT / 2);
            for frame in 0..FRAMES {
                let start = (frame + 2) * HOP_LENGTH;
                for index in 0..N_FFT {
                    self.input[index] = centered[start + index] * self.window[index];
                }
                self.forward.process(&mut self.input, &mut self.output)?;
                for frequency in 0..FREQUENCIES {
                    let value = self.output[frequency] / (N_FFT as f32).sqrt();
                    packed[packed_index(channel_index * 2, frequency, frame)] = value.re;
                    packed[packed_index(channel_index * 2 + 1, frequency, frame)] = value.im;
                }
            }
        }
        Ok(packed)
    }
}

impl Default for Stft {
    fn default() -> Self {
        Self::new()
    }
}

fn packed_index(channel: usize, frequency: usize, frame: usize) -> usize {
    (channel * FREQUENCIES + frequency) * FRAMES + frame
}

fn reflect_pad(input: &[f32], left: usize, right: usize) -> Vec<f32> {
    let mut output = Vec::with_capacity(left + input.len() + right);
    output.extend((1..=left).rev().map(|index| input[index]));
    output.extend_from_slice(input);
    output.extend((1..=right).map(|index| input[input.len() - 1 - index]));
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const REFERENCE: &[u8] = include_bytes!("../../../fixtures/stft-reference-f32.bin");
    const FREQUENCY_STEP: usize = 32;
    const SELECTED_FREQUENCIES: usize = FREQUENCIES / FREQUENCY_STEP;

    fn deterministic_waveform() -> [Vec<f32>; CHANNELS] {
        let mut state = 0x12345678_u32;
        std::array::from_fn(|_| {
            (0..SEGMENT)
                .map(|_| {
                    state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                    (f32::from_bits(0x3f800000 | (state >> 9)) - 1.0) * 2.0 - 1.0
                })
                .collect()
        })
    }

    #[test]
    fn matches_pytorch_reference() {
        assert_eq!(
            REFERENCE.len(),
            CAC_CHANNELS * SELECTED_FREQUENCIES * FRAMES * size_of::<f32>()
        );
        let actual = Stft::new().process(&deterministic_waveform()).unwrap();

        let mut max_abs = 0.0_f32;
        let mut squared_error = 0.0_f64;
        let mut count = 0;
        for channel in 0..CAC_CHANNELS {
            for selected in 0..SELECTED_FREQUENCIES {
                let frequency = selected * FREQUENCY_STEP;
                for frame in 0..FRAMES {
                    let reference_index =
                        (channel * SELECTED_FREQUENCIES + selected) * FRAMES + frame;
                    let offset = reference_index * size_of::<f32>();
                    let expected =
                        f32::from_le_bytes(REFERENCE[offset..offset + 4].try_into().unwrap());
                    let error = (actual[packed_index(channel, frequency, frame)] - expected).abs();
                    max_abs = max_abs.max(error);
                    squared_error += f64::from(error).powi(2);
                    count += 1;
                }
            }
        }
        let mse = squared_error / count as f64;
        eprintln!("STFT parity: max abs {max_abs:.3e}, mse {mse:.3e}");
        assert!(max_abs < 1e-4, "max abs {max_abs:.3e}");
        assert!(mse < 1e-10, "mse {mse:.3e}");
    }
}
