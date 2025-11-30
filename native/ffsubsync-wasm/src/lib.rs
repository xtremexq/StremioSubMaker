//! ffsubsync-style audio-to-subtitle alignment for wasm32 (MV3-safe).
//! Inputs: WAV (PCM16 mono) or raw PCM i16 + SRT. Output: shifted SRT + metadata.

use num_complex::Complex32;
use serde_wasm_bindgen;
use std::cmp::{max, min};
use wasm_bindgen::prelude::*;

#[derive(thiserror::Error, Debug)]
enum SyncError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("wav parse failed: {0}")]
    Wav(String),
    #[error("srt parse failed: {0}")]
    Srt(String),
    #[error("alignment failed: {0}")]
    Align(String),
}

impl From<SyncError> for JsValue {
    fn from(err: SyncError) -> Self {
        JsValue::from_str(&err.to_string())
    }
}

#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct FfsubsyncOptions {
    /// Frame size in milliseconds (default 10).
    pub frame_ms: u16,
    /// Maximum absolute offset to search in milliseconds (default 60000).
    pub max_offset_ms: u32,
    /// Use golden-section search for drift detection (default false).
    pub gss: bool,
    /// Expected sample rate of incoming PCM (default 16000).
    pub sample_rate: u32,
    /// VAD aggressiveness 0..3 (controls energy threshold).
    pub vad_aggressiveness: u8,
}

#[wasm_bindgen]
impl FfsubsyncOptions {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FfsubsyncOptions {
        FfsubsyncOptions::default()
    }
}

impl Default for FfsubsyncOptions {
  fn default() -> Self {
    FfsubsyncOptions {
        frame_ms: 10,
        max_offset_ms: 60_000,
        gss: false,
        sample_rate: 16_000,
        vad_aggressiveness: 2,
    }
  }
}

#[wasm_bindgen(getter_with_clone)]
pub struct FfsubsyncResult {
    pub offset_ms: i32,
    pub drift: f32,
    pub confidence: f32,
    pub segments_used: u32,
    pub srt: String,
}

#[wasm_bindgen]
impl FfsubsyncResult {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FfsubsyncResult {
        FfsubsyncResult {
            offset_ms: 0,
            drift: 1.0,
            confidence: 0.0,
            segments_used: 0,
            srt: String::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct Subtitle {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

#[wasm_bindgen]
pub fn align_pcm(pcm: &[i16], opts: JsValue, srt: &str) -> Result<FfsubsyncResult, JsValue> {
    let opts: FfsubsyncOptions = serde_wasm_bindgen::from_value(opts).unwrap_or_default();
    if pcm.is_empty() {
        return Err(SyncError::InvalidInput("PCM buffer is empty".into()).into());
    }
    let audio_sr = if opts.sample_rate > 0 { opts.sample_rate } else { 16_000 };
    let audio_mask = build_audio_mask(pcm, audio_sr, opts.frame_ms, opts.vad_aggressiveness);
    let subtitles = parse_srt(srt)?;
    let subtitle_mask = build_sub_mask(&subtitles, opts.frame_ms);
    let max_offset_ms = opts.max_offset_ms.max(1000);
    let (offset_ms, drift, confidence) = align_masks(&audio_mask, &subtitle_mask, opts.frame_ms, max_offset_ms, opts.gss);
    let shifted = rewrite_srt(&subtitles, offset_ms, drift);
    Ok(FfsubsyncResult {
        offset_ms,
        drift,
        confidence,
        segments_used: subtitles.len() as u32,
        srt: shifted,
    })
}

#[wasm_bindgen]
pub fn align_wav(wav_bytes: &[u8], opts: JsValue, srt: &str) -> Result<FfsubsyncResult, JsValue> {
    let mut cfg: FfsubsyncOptions = serde_wasm_bindgen::from_value(opts).unwrap_or_default();
    let (pcm, sr) = parse_wav(wav_bytes)?;
    cfg.sample_rate = sr;
    // Re-encode opts back into JsValue so align_pcm can parse with the same path
    let opts_val = serde_wasm_bindgen::to_value(&cfg).map_err(|e| SyncError::InvalidInput(format!("opts encode failed: {}", e)))?;
    align_pcm(&pcm, opts_val, srt)
}

fn parse_wav(buf: &[u8]) -> Result<(Vec<i16>, u32), SyncError> {
    if buf.len() < 44 {
        return Err(SyncError::Wav("buffer too small".into()));
    }
    let mut idx = 12;
    let read_u32 = |b: &[u8], i: usize| -> u32 { u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) };
    let read_u16 = |b: &[u8], i: usize| -> u16 { u16::from_le_bytes([b[i], b[i + 1]]) };
    if &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" {
        return Err(SyncError::Wav("missing RIFF/WAVE header".into()));
    }

    let mut fmt_audio_format = 0u16;
    let mut fmt_channels = 0u16;
    let mut fmt_sample_rate = 0u32;
    let mut fmt_bits_per_sample = 0u16;
    let mut data_offset = None;
    let mut data_size = None;

    while idx + 8 <= buf.len() {
        let chunk_id = &buf[idx..idx + 4];
        let chunk_size = read_u32(buf, idx + 4) as usize;
        let chunk_start = idx + 8;
        if chunk_start + chunk_size > buf.len() {
            break;
        }
        match chunk_id {
            b"fmt " => {
                fmt_audio_format = read_u16(buf, chunk_start);
                fmt_channels = read_u16(buf, chunk_start + 2);
                fmt_sample_rate = read_u32(buf, chunk_start + 4);
                fmt_bits_per_sample = read_u16(buf, chunk_start + 14);
            }
            b"data" => {
                data_offset = Some(chunk_start);
                data_size = Some(chunk_size);
                break;
            }
            _ => {}
        }
        idx = chunk_start + chunk_size;
    }

    let data_offset = data_offset.ok_or_else(|| SyncError::Wav("missing data chunk".into()))?;
    let data_size = data_size.ok_or_else(|| SyncError::Wav("missing data size".into()))?;

    if fmt_audio_format != 1 {
        return Err(SyncError::Wav("only PCM is supported".into()));
    }
    if fmt_bits_per_sample != 16 {
        return Err(SyncError::Wav("only 16-bit PCM supported".into()));
    }
    if fmt_channels != 1 {
        return Err(SyncError::Wav("only mono audio supported".into()));
    }
    if fmt_sample_rate == 0 {
        return Err(SyncError::Wav("invalid sample rate".into()));
    }

    let sample_count = data_size / 2;
    if data_offset + data_size > buf.len() {
        return Err(SyncError::Wav("data chunk truncated".into()));
    }
    let mut pcm = Vec::with_capacity(sample_count);
    for i in 0..sample_count {
        let pos = data_offset + i * 2;
        let sample = i16::from_le_bytes([buf[pos], buf[pos + 1]]);
        pcm.push(sample);
    }
    Ok((pcm, fmt_sample_rate))
}

fn build_audio_mask(pcm: &[i16], sample_rate: u32, frame_ms: u16, vad_aggr: u8) -> Vec<f32> {
    let frame_ms = frame_ms.max(2) as usize;
    let sr = sample_rate.max(8_000) as usize;
    let frame_samples = max(1, sr * frame_ms / 1000);
    let total_frames = (pcm.len() + frame_samples - 1) / frame_samples;
    let mut energies = Vec::with_capacity(total_frames);
    for frame_idx in 0..total_frames {
        let start = frame_idx * frame_samples;
        let end = min(pcm.len(), start + frame_samples);
        let mut energy: f64 = 0.0;
        for &s in &pcm[start..end] {
            let v = s as f64;
            energy += v * v;
        }
        energy /= (end - start).max(1) as f64;
        energies.push(energy as f32);
    }

    let mean_energy = energies.iter().copied().sum::<f32>() / energies.len().max(1) as f32;
    let max_energy = energies.iter().copied().fold(0.0f32, f32::max);
    let min_energy = energies.iter().copied().fold(f32::MAX, f32::min);
    let floor = if min_energy.is_finite() { min_energy } else { 0.0 };
    let aggr = min(vad_aggr, 3) as f32;
    let base = floor + (mean_energy - floor).abs() * (0.3 + 0.1 * aggr);
    let threshold = if max_energy > 0.0 {
        base.max(max_energy * (0.04 + 0.02 * aggr))
    } else {
        0.0
    };

    energies
        .into_iter()
        .map(|e| if e >= threshold { 1.0 } else { 0.0 })
        .collect()
}

fn build_sub_mask(subs: &[Subtitle], frame_ms: u16) -> Vec<f32> {
    let frame_ms = frame_ms.max(2) as i64;
    let mut max_end = 0i64;
    for s in subs {
        max_end = max(max_end, s.end_ms);
    }
    let total_frames = ((max_end + frame_ms - 1) / frame_ms).max(1) as usize;
    let mut mask = vec![0f32; total_frames];
    for sub in subs {
        let start_frame = max(0, sub.start_ms / frame_ms) as usize;
        let end_frame_i64 = ((sub.end_ms + frame_ms - 1) / frame_ms).max(sub.start_ms / frame_ms);
        let end_frame = end_frame_i64.max(0) as usize;
        let capped_end = min(end_frame, total_frames);
        for f in start_frame..capped_end {
          mask[f] = 1.0;
        }
    }
    mask
}

fn correlate_masks(audio: &[f32], subs: &[f32], frame_ms: u16, max_offset_ms: u32) -> Result<(i32, f32), SyncError> {
    use rustfft::FftPlanner;

    if audio.is_empty() || subs.is_empty() {
        return Err(SyncError::Align("empty masks".into()));
    }

    let len_a = audio.len();
    let len_b = subs.len();
    let conv_len = len_a + len_b - 1;
    let fft_len = conv_len.next_power_of_two();

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_len);
    let ifft = planner.plan_fft_inverse(fft_len);

    let mut fa = vec![Complex32::new(0.0, 0.0); fft_len];
    let mut fb = vec![Complex32::new(0.0, 0.0); fft_len];

    for i in 0..len_a {
        fa[i].re = audio[i];
    }
    for i in 0..len_b {
        fb[i].re = subs[i];
    }

    fft.process(&mut fa);
    fft.process(&mut fb);

    for i in 0..fft_len {
        fa[i] = fa[i] * fb[i].conj();
    }

    ifft.process(&mut fa);
    let scale = 1.0 / fft_len as f32;
    let mut corr: Vec<f32> = fa.iter().map(|c| c.re * scale).collect();

    // Normalize by lengths to keep scores comparable
    let norm = ((len_a.min(len_b)) as f32).max(1.0);
    for c in corr.iter_mut() {
        *c /= norm;
    }

    let max_offset_frames = (max_offset_ms as f32 / frame_ms as f32).ceil() as isize;
    let base = (len_b - 1) as isize;
    let mut best_score = f32::MIN;
    let mut best_idx: isize = base;
    let mut second_best = f32::MIN;

    for (i, &val) in corr.iter().enumerate() {
        let lag = i as isize - base;
        if lag.abs() as isize > max_offset_frames {
            continue;
        }
        if val > best_score {
            second_best = best_score;
            best_score = val;
            best_idx = i as isize;
        } else if val > second_best {
            second_best = val;
        }
    }

    let lag_frames = best_idx - base;
    let offset_ms = (lag_frames * frame_ms as isize) as i32;

    let confidence = if !best_score.is_finite() {
        0.0
    } else {
        let gap = best_score - second_best.max(-1.0);
        let normalized = (best_score / (subs.iter().copied().sum::<f32>().max(1.0))).abs();
        (0.6 * normalized + 0.4 * gap.abs()).min(1.0)
    };

    Ok((offset_ms, confidence))
}

fn resample_mask(mask: &[f32], ratio: f32) -> Vec<f32> {
    if ratio <= 0.0 || mask.is_empty() {
        return mask.to_vec();
    }
    let new_len = ((mask.len() as f32) * ratio).ceil().max(1.0) as usize;
    let mut out = vec![0f32; new_len];
    for i in 0..new_len {
        let src_pos = (i as f32) / ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - (idx as f32);
        let a = *mask.get(idx).unwrap_or(&0.0);
        let b = *mask.get(idx + 1).unwrap_or(&a);
        out[i] = a * (1.0 - frac) + b * frac;
    }
    out
}

fn align_masks(audio: &[f32], subs: &[f32], frame_ms: u16, max_offset_ms: u32, gss: bool) -> (i32, f32, f32) {
    // Evaluate drift candidates; if gss is off, just use 1.0
    let mut candidates = vec![1.0f32];
    if gss {
        candidates = vec![0.97, 0.985, 1.0, 1.015, 1.03];
    }

    let mut best = (0i32, 1.0f32, f32::MIN);
    for &ratio in &candidates {
        let stretched = if (ratio - 1.0).abs() < 0.0001 {
            subs.to_vec()
        } else {
            resample_mask(subs, ratio)
        };
        match correlate_masks(audio, &stretched, frame_ms, max_offset_ms) {
            Ok((offset_ms, score)) => {
                if score > best.2 {
                    best = (offset_ms, ratio, score);
                }
            }
            Err(_) => continue,
        }
    }

    let (mut offset_ms, mut drift, mut best_score) = best;

    // Optional refinement: small local tweaks around best ratio
    if gss {
        let step = 0.005;
        let low = (drift - step).max(0.95);
        let high = (drift + step).min(1.05);
        for ratio in [low, drift, high] {
            let stretched = if (ratio - 1.0).abs() < 0.0001 {
                subs.to_vec()
            } else {
                resample_mask(subs, ratio)
            };
            if let Ok((off, score)) = correlate_masks(audio, &stretched, frame_ms, max_offset_ms) {
                if score > best_score {
                    best_score = score;
                    offset_ms = off;
                    drift = ratio;
                }
            }
        }
    }

    let confidence = best_score.max(0.0).min(1.0);
    (offset_ms, drift, confidence)
}

fn rewrite_srt(subs: &[Subtitle], offset_ms: i32, drift: f32) -> String {
    let mut out = String::new();
    for (idx, s) in subs.iter().enumerate() {
        let start = ((s.start_ms as f32) * drift + offset_ms as f32).max(0.0) as i64;
        let end = ((s.end_ms as f32) * drift + offset_ms as f32).max(start as f32) as i64;
        out.push_str(&(idx + 1).to_string());
        out.push('\n');
        out.push_str(&format!("{} --> {}\n", format_time(start), format_time(end)));
        out.push_str(s.text.trim());
        out.push_str("\n\n");
    }
    out.trim_end().to_string()
}

fn parse_timecode(tc: &str) -> Option<i64> {
    let parts: Vec<&str> = tc.split([':', ',']).collect();
    if parts.len() != 4 {
        return None;
    }
    let h: i64 = parts.get(0)?.parse().ok()?;
    let m: i64 = parts.get(1)?.parse().ok()?;
    let s: i64 = parts.get(2)?.parse().ok()?;
    let ms: i64 = parts.get(3)?.parse().ok()?;
    Some(((h * 3600 + m * 60 + s) * 1000) + ms)
}

fn format_time(ms: i64) -> String {
    let total_ms = ms.max(0);
    let hours = total_ms / 3_600_000;
    let minutes = (total_ms / 60_000) % 60;
    let seconds = (total_ms / 1000) % 60;
    let millis = total_ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", hours, minutes, seconds, millis)
}

fn parse_srt(input: &str) -> Result<Vec<Subtitle>, SyncError> {
    let mut subs = Vec::new();
    let mut lines = input.lines().peekable();
    while let Some(_) = lines.peek() {
        // Skip optional index line
        if let Some(line) = lines.peek() {
          if line.trim().is_empty() {
            lines.next();
            continue;
          }
        }
        let _idx_line = lines.next();
        let time_line = match lines.next() {
            Some(t) => t.trim(),
            None => break,
        };
        let arrow = "-->";
        let parts: Vec<&str> = time_line.split(arrow).map(|s| s.trim()).collect();
        if parts.len() != 2 {
            return Err(SyncError::Srt(format!("invalid time line: {}", time_line)));
        }
        let start = parse_timecode(parts[0]).ok_or_else(|| SyncError::Srt("bad start time".into()))?;
        let end = parse_timecode(parts[1]).ok_or_else(|| SyncError::Srt("bad end time".into()))?;

        let mut text_lines = Vec::new();
        while let Some(&line) = lines.peek() {
            if line.trim().is_empty() {
                lines.next();
                break;
            }
            text_lines.push(lines.next().unwrap());
        }
        let text = text_lines.join("\n");
        subs.push(Subtitle { start_ms: start, end_ms: end, text });
    }
    if subs.is_empty() {
        return Err(SyncError::Srt("no subtitles parsed".into()));
    }
    Ok(subs)
}
