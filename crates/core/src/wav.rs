//! Wav codec: bytes <-> stereo f32 buffers. Where the bytes live (file, JS buffer) is
//! the driver's concern; core never touches the filesystem.

use crate::{CHANNELS, SAMPLERATE};
use anyhow::Result;
use std::io::Cursor;

/// Decode wav bytes at their native rate, deinterleaving the LRLR frames into
/// per-channel f32 buffers (`[channel][sample]`).
pub fn decode_wav(bytes: &[u8]) -> Result<(Vec<Vec<f32>>, u32)> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes))?;
    let spec = reader.spec();
    let nch = spec.channels as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    let mut planar = vec![Vec::with_capacity(interleaved.len() / nch); nch];
    for frame in interleaved.chunks_exact(nch) {
        for (ch, &s) in frame.iter().enumerate() {
            planar[ch].push(s);
        }
    }
    Ok((planar, spec.sample_rate))
}

/// Encode stereo 44.1k f32 buffers as wav bytes (f32, interleaved).
pub fn encode_wav(channels: &[Vec<f32>; CHANNELS]) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: CHANNELS as u16,
        sample_rate: SAMPLERATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cursor = Cursor::new(Vec::new());
    let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
    for i in 0..channels[0].len() {
        for ch in channels {
            writer.write_sample(ch[i])?;
        }
    }
    writer.finalize()?;
    Ok(cursor.into_inner())
}
