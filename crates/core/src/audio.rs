//! Input conforming: channel layout, and (behind the `resample` feature) sinc resampling.
//! The browser tier does both natively (decodeAudioData at a 44.1k context).

use crate::CHANNELS;

/// Mirror demucs convert_audio_channels: arbitrary decoded channels in, stereo out —
/// mono replicated, extra channels dropped.
pub fn conform_channels(planar: Vec<Vec<f32>>) -> [Vec<f32>; CHANNELS] {
    let mut it = planar.into_iter();
    match (it.next(), it.next()) {
        (Some(l), Some(r)) => [l, r],          // channels beyond two are dropped
        (Some(l), None) => [l.clone(), l],     // mono replicated
        (None, _) => [Vec::new(), Vec::new()], // empty input; the engine rejects it
    }
}

/// High-quality sinc resample to 44.1kHz, delay-compensated and trimmed to exact length.
#[cfg(feature = "resample")]
pub fn resample(
    planar: [Vec<f32>; CHANNELS],
    from: u32,
) -> anyhow::Result<[Vec<f32>; CHANNELS]> {
    use crate::SAMPLERATE;
    use anyhow::{anyhow, bail};
    use rubato::{
        Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    };
    if from == SAMPLERATE {
        return Ok(planar);
    }
    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };
    let chunk = 1024;
    let mut rs =
        SincFixedIn::<f32>::new(SAMPLERATE as f64 / from as f64, 2.0, params, chunk, CHANNELS)
            .map_err(|e| anyhow!("rubato: {e}"))?;
    let mut out: [Vec<f32>; CHANNELS] = Default::default();
    let mut pos = 0;
    let len = planar[0].len();
    loop {
        let need = rs.input_frames_next();
        if pos + need > len {
            break;
        }
        let waves: Vec<&[f32]> = planar.iter().map(|ch| &ch[pos..pos + need]).collect();
        let done = rs.process(&waves, None).map_err(|e| anyhow!("rubato: {e}"))?;
        for (ch, d) in out.iter_mut().zip(done) {
            ch.extend(d);
        }
        pos += need;
    }
    if pos < len {
        let waves: Vec<&[f32]> = planar.iter().map(|ch| &ch[pos..]).collect();
        let done = rs
            .process_partial(Some(&waves), None)
            .map_err(|e| anyhow!("rubato: {e}"))?;
        for (ch, d) in out.iter_mut().zip(done) {
            ch.extend(d);
        }
    }
    let delay = rs.output_delay();
    let expected = ((len as f64) * SAMPLERATE as f64 / from as f64).round() as usize;
    while out[0].len() < delay + expected {
        let done = rs
            .process_partial(None::<&[&[f32]]>, None)
            .map_err(|e| anyhow!("rubato: {e}"))?;
        if done[0].is_empty() {
            break;
        }
        for (ch, d) in out.iter_mut().zip(done) {
            ch.extend(d);
        }
    }
    let out = out.map(|ch| {
        let end = (delay + expected).min(ch.len());
        ch[delay.min(ch.len())..end].to_vec()
    });
    if out[0].len() < expected {
        bail!("resampler produced {} of {expected} expected samples", out[0].len());
    }
    Ok(out)
}
