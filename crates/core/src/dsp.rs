//! Runtime spectral preprocessing for split-DSP HTDemucs models.

use anyhow::{bail, Result};
use realfft::{num_complex::Complex32, ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

use crate::{CHANNELS, NUM_SOURCES, SEGMENT};

pub const N_FFT: usize = 4096;
pub const HOP_LENGTH: usize = 1024;
pub const FREQUENCIES: usize = 2048;
pub const FRAMES: usize = 336;
pub const CAC_CHANNELS: usize = CHANNELS * 2;

const ALIGNMENT_PAD: usize = 3 * HOP_LENGTH / 2;
const ALIGNED_LENGTH: usize = FRAMES * HOP_LENGTH;
const ISTFT_FRAMES: usize = FRAMES + 4;
const ISTFT_LENGTH: usize = N_FFT + HOP_LENGTH * (ISTFT_FRAMES - 1);
const CENTER_PAD: usize = N_FFT / 2;

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

    /// Convert flattened planar stereo `[channel, sample]` into flattened
    /// `[1, left-real/imag, right-real/imag, frequency, frame]` data.
    pub fn process(&mut self, waveform: &[f32]) -> Result<Vec<f32>> {
        let expected = CHANNELS * SEGMENT;
        if waveform.len() != expected {
            bail!("STFT requires {expected} waveform values");
        }

        let mut packed = vec![0.0; CAC_CHANNELS * FREQUENCIES * FRAMES];
        for channel_index in 0..CHANNELS {
            let channel = &waveform[channel_index * SEGMENT..(channel_index + 1) * SEGMENT];
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

/// Reusable inverse FFT state for reconstructing the frequency branch.
pub struct Istft {
    inverse: Arc<dyn ComplexToReal<f32>>,
    window: Vec<f32>,
    window_sum: Vec<f32>,
    spectrum: Vec<Complex32>,
    frame: Vec<f32>,
    accumulation: Vec<f32>,
}

impl Istft {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let inverse = planner.plan_fft_inverse(N_FFT);
        let spectrum = inverse.make_input_vec();
        let frame = inverse.make_output_vec();
        let window: Vec<f32> = (0..N_FFT)
            .map(|index| {
                0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / N_FFT as f32).cos()
            })
            .collect();
        let mut window_sum = vec![0.0; ISTFT_LENGTH];
        for frame_index in 0..ISTFT_FRAMES {
            let start = frame_index * HOP_LENGTH;
            for index in 0..N_FFT {
                window_sum[start + index] += window[index] * window[index];
            }
        }
        Self {
            inverse,
            window,
            window_sum,
            spectrum,
            frame,
            accumulation: vec![0.0; ISTFT_LENGTH],
        }
    }

    /// Convert flattened `[1, source, CaC, frequency, frame]` output into
    /// `[source, channel, sample]` waveforms.
    pub fn process(&mut self, frequency: &[f32]) -> Result<Vec<f32>> {
        let expected = NUM_SOURCES * CAC_CHANNELS * FREQUENCIES * FRAMES;
        if frequency.len() != expected {
            bail!("iSTFT requires {expected} frequency values");
        }

        let mut waveform = vec![0.0; NUM_SOURCES * CHANNELS * SEGMENT];
        for source in 0..NUM_SOURCES {
            for channel in 0..CHANNELS {
                self.accumulation.fill(0.0);
                for frame_index in 0..ISTFT_FRAMES {
                    self.spectrum.fill(Complex32::new(0.0, 0.0));
                    if (2..FRAMES + 2).contains(&frame_index) {
                        let input_frame = frame_index - 2;
                        for frequency_index in 0..FREQUENCIES {
                            self.spectrum[frequency_index] = Complex32::new(
                                frequency[frequency_index_for(
                                    source,
                                    channel * 2,
                                    frequency_index,
                                    input_frame,
                                )],
                                frequency[frequency_index_for(
                                    source,
                                    channel * 2 + 1,
                                    frequency_index,
                                    input_frame,
                                )],
                            );
                        }
                        // A real FFT's DC bin has no imaginary component. PyTorch ignores it;
                        // realfft validates the invariant explicitly.
                        self.spectrum[0].im = 0.0;
                    }
                    self.inverse.process(&mut self.spectrum, &mut self.frame)?;
                    let start = frame_index * HOP_LENGTH;
                    for index in 0..N_FFT {
                        self.accumulation[start + index] +=
                            self.frame[index] * self.window[index] / (N_FFT as f32).sqrt();
                    }
                }

                let trim = CENTER_PAD + ALIGNMENT_PAD;
                let output_start = (source * CHANNELS + channel) * SEGMENT;
                for sample in 0..SEGMENT {
                    let index = trim + sample;
                    waveform[output_start + sample] =
                        self.accumulation[index] / self.window_sum[index];
                }
            }
        }
        Ok(waveform)
    }
}

impl Default for Istft {
    fn default() -> Self {
        Self::new()
    }
}

fn packed_index(channel: usize, frequency: usize, frame: usize) -> usize {
    (channel * FREQUENCIES + frequency) * FRAMES + frame
}

fn frequency_index_for(source: usize, channel: usize, frequency: usize, frame: usize) -> usize {
    ((source * CAC_CHANNELS + channel) * FREQUENCIES + frequency) * FRAMES + frame
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
    const ISTFT_REFERENCE: &[u8] = include_bytes!("../../../fixtures/istft-reference-f32.bin");
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

    fn deterministic_frequency_output() -> Vec<f32> {
        let mut state = 0x87654321_u32;
        (0..NUM_SOURCES * CAC_CHANNELS * FREQUENCIES * FRAMES)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (f32::from_bits(0x3f800000 | (state >> 9)) - 1.0) * 2.0 - 1.0
            })
            .collect()
    }

    #[test]
    fn matches_pytorch_reference() {
        assert_eq!(
            REFERENCE.len(),
            CAC_CHANNELS * SELECTED_FREQUENCIES * FRAMES * size_of::<f32>()
        );
        let waveform = deterministic_waveform().concat();
        let actual = Stft::new().process(&waveform).unwrap();

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

    #[test]
    fn istft_matches_pytorch_reference() {
        const SAMPLE_STEP: usize = 8;
        let selected_samples = SEGMENT.div_ceil(SAMPLE_STEP);
        assert_eq!(
            ISTFT_REFERENCE.len(),
            NUM_SOURCES * CHANNELS * selected_samples * size_of::<f32>()
        );
        let actual = Istft::new()
            .process(&deterministic_frequency_output())
            .unwrap();

        let mut max_abs = 0.0_f32;
        let mut squared_error = 0.0_f64;
        let mut count = 0;
        for source in 0..NUM_SOURCES {
            for channel in 0..CHANNELS {
                for selected in 0..selected_samples {
                    let sample = selected * SAMPLE_STEP;
                    let reference_index =
                        (source * CHANNELS + channel) * selected_samples + selected;
                    let offset = reference_index * size_of::<f32>();
                    let expected =
                        f32::from_le_bytes(ISTFT_REFERENCE[offset..offset + 4].try_into().unwrap());
                    let error =
                        (actual[(source * CHANNELS + channel) * SEGMENT + sample] - expected).abs();
                    max_abs = max_abs.max(error);
                    squared_error += f64::from(error).powi(2);
                    count += 1;
                }
            }
        }
        let mse = squared_error / count as f64;
        eprintln!("iSTFT parity: max abs {max_abs:.3e}, mse {mse:.3e}");
        assert!(max_abs < 1e-4, "max abs {max_abs:.3e}");
        assert!(mse < 1e-10, "mse {mse:.3e}");
    }
}
