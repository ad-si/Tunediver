// Waveform extraction.
//
// Reduces a track to a fixed-length array of 0-255 values — the shape the
// transport draws behind its seek bar. Getting there means decoding the whole
// file to PCM, which costs seconds and is why callers cache the result (see
// `db::get_waveform` / `db::set_waveform`); nothing in here touches the
// database or the catalog.
//
// The value per slice is RMS energy, not peak amplitude. Peak is the obvious
// choice and the wrong one for this collection: a modern pop master is
// limited so hard that every slice of it touches the ceiling, which draws as a
// featureless slab no matter what curve is applied afterwards. RMS tracks how
// much energy is actually there, so a verse still reads as quieter than a
// chorus on a track whose peaks never move.

use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

use symphonia::core::audio::{SampleBuffer, SignalSpec};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// Slices per track. The transport's waveform is at most 600px wide and the
// shape is drawn stretched to whatever width it gets, so 400 slices stay
// smooth at every window size while the payload remains well under a kilobyte.
pub const BUCKETS: usize = 400;

// Version of the extraction below. Cached rows record the version that produced
// them and are recomputed when it no longer matches, so a change to the shape
// (a different measure, a different normalization) heals existing caches
// instead of leaving old and new waveforms mixed together. v1 measured peak
// amplitude; v2 measures RMS energy and normalizes against a high percentile.
pub const PEAKS_VERSION: i64 = 2;

// Samples folded into one raw measurement before bucketing. Channels are
// counted individually, so this is a frame count only for mono — near enough,
// since the result is squashed into BUCKETS slices regardless. Small enough
// that even a 20-second track yields several measurements per slice, large
// enough that a long track's intermediate vector stays modest (a 10-minute
// stereo track yields ~100k f32s ≈ 400 KB).
const BLOCK_SAMPLES: usize = 512;

// Normalizing against the single loudest measurement lets one stray transient
// (a snare crack, a click in a bad rip) squash the entire rest of the track.
// Taking the level near the top of the distribution instead is stable, and the
// handful of measurements above it simply clamp to full height.
const NORMALIZE_PERCENTILE: f32 = 0.98;

// Sample rate the ffmpeg fallback resamples to. The result is squashed into
// BUCKETS slices anyway, so decoding at CD rate would only cost time; this
// still leaves ~40 raw measurements per second of audio.
const FFMPEG_SAMPLE_RATE: &str = "22050";

// Waveform values for `path`, or None if it has no audio that can be decoded
// at all. The in-process decoder covers everything the collection is made of
// (mp3, m4a, flac, wav, ogg); ffmpeg, when installed, picks up the formats it
// lacks — Opus above all.
pub fn compute_peaks(path: &Path) -> Option<Vec<u8>> {
  let raw =
    raw_levels_via_symphonia(path).or_else(|| raw_levels_via_ffmpeg(path))?;
  Some(bucketize(&raw))
}

// Folds a stream of samples into one RMS value per BLOCK_SAMPLES samples, so
// both decoders can share the measurement and differ only in how they get the
// samples out of the file.
struct Levels {
  blocks: Vec<f32>,
  // f64 because a block of loud samples sums to a value a f32 accumulator
  // starts rounding away.
  sum_of_squares: f64,
  samples: usize,
}

impl Levels {
  fn new() -> Self {
    Levels {
      blocks: Vec::new(),
      sum_of_squares: 0.0,
      samples: 0,
    }
  }

  fn push(&mut self, sample: f32) {
    // A decoder that hands back a NaN (corrupt frame) would poison the whole
    // block's average, so drop it rather than let it propagate.
    if sample.is_nan() {
      return;
    }
    self.sum_of_squares += (sample as f64) * (sample as f64);
    self.samples += 1;
    if self.samples >= BLOCK_SAMPLES {
      self.close_block();
    }
  }

  fn close_block(&mut self) {
    if self.samples == 0 {
      return;
    }
    let mean = self.sum_of_squares / self.samples as f64;
    self.blocks.push(mean.sqrt() as f32);
    self.sum_of_squares = 0.0;
    self.samples = 0;
  }

  // The finished measurements, or None if the file yielded no audio at all.
  fn finish(mut self) -> Option<Vec<f32>> {
    self.close_block();
    if self.blocks.is_empty() {
      return None;
    }
    Some(self.blocks)
  }
}

// Raw levels decoded in-process. None if the file can't be opened or holds no
// track in a codec symphonia was built with. A file that decodes only
// partially — truncated, or with corrupt frames in the middle — still yields
// levels for the part that did decode rather than failing outright.
fn raw_levels_via_symphonia(path: &Path) -> Option<Vec<f32>> {
  let file = std::fs::File::open(path).ok()?;
  let stream = MediaSourceStream::new(Box::new(file), Default::default());

  // The extension is only a hint; symphonia still sniffs the actual container.
  let mut hint = Hint::new();
  if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
    hint.with_extension(ext);
  }

  let probed = symphonia::default::get_probe()
    .format(
      &hint,
      stream,
      &FormatOptions::default(),
      &MetadataOptions::default(),
    )
    .ok()?;
  let mut format = probed.format;

  // Video containers (mp4/webm music videos are part of the catalog) carry
  // several streams; take the first one with an actual audio codec.
  let track = format
    .tracks()
    .iter()
    .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
  let track_id = track.id;
  let mut decoder = symphonia::default::get_codecs()
    .make(&track.codec_params, &DecoderOptions::default())
    .ok()?;

  let mut levels = Levels::new();
  // Allocated lazily from the first decoded packet, and reallocated if a later
  // packet is bigger or switches format (chained OGG streams can do both).
  let mut samples: Option<(SampleBuffer<f32>, SignalSpec, u64)> = None;

  // The loop ends on the first error from `next_packet`, which covers both the
  // end of the stream and a read failure partway through — either way, what
  // was decoded up to that point is kept.
  while let Ok(packet) = format.next_packet() {
    if packet.track_id() != track_id {
      continue;
    }

    let decoded = match decoder.decode(&packet) {
      Ok(decoded) => decoded,
      // A single corrupt frame is recoverable — skip it and keep going.
      Err(Error::DecodeError(_)) => continue,
      Err(_) => break,
    };

    let spec = *decoded.spec();
    let capacity = decoded.capacity() as u64;
    let reuse = match &samples {
      Some((_, buf_spec, buf_capacity)) => {
        *buf_spec == spec && *buf_capacity >= capacity
      }
      None => false,
    };
    if !reuse {
      samples = Some((SampleBuffer::new(capacity, spec), spec, capacity));
    }
    let (buffer, _, _) = samples.as_mut()?;
    buffer.copy_interleaved_ref(decoded);

    for sample in buffer.samples() {
      levels.push(*sample);
    }
  }

  levels.finish()
}

// The same levels by way of ffmpeg, for formats symphonia has no decoder for
// (Opus, WMA). Entirely optional: on a machine without ffmpeg the spawn fails
// and those tracks simply get no waveform. ffmpeg does the downmix and
// resample itself, so what arrives on its stdout is a bare stream of mono
// little-endian f32 samples with no header to skip.
fn raw_levels_via_ffmpeg(path: &Path) -> Option<Vec<f32>> {
  let mut child = Command::new("ffmpeg")
    .args(["-v", "quiet"])
    .arg("-i")
    .arg(path)
    // First audio stream only — a music video carries a video stream too.
    .args(["-map", "0:a:0"])
    .args(["-ac", "1", "-ar", FFMPEG_SAMPLE_RATE, "-f", "f32le", "-"])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;

  let mut levels = Levels::new();
  {
    let stdout = child.stdout.take()?;
    let mut reader = BufReader::new(stdout);
    let mut buffer = [0u8; 8192];
    // A 4-byte sample can straddle two reads, so whatever doesn't divide
    // evenly is carried over to the next one.
    let mut pending: Vec<u8> = Vec::new();

    loop {
      let read = match reader.read(&mut buffer) {
        Ok(0) => break,
        Ok(read) => read,
        Err(_) => break,
      };
      pending.extend_from_slice(&buffer[..read]);
      let usable = pending.len() - pending.len() % 4;
      for sample in pending[..usable].chunks_exact(4) {
        levels.push(f32::from_le_bytes([
          sample[0], sample[1], sample[2], sample[3],
        ]));
      }
      pending.drain(..usable);
    }
  }
  // stdout is drained by now, so the child is done or about to be; reap it
  // either way rather than leaving a zombie behind.
  let _ = child.wait();

  levels.finish()
}

// Resample the raw measurements down to BUCKETS values and normalize them to
// 0-255. Each slice averages the measurements it covers rather than taking
// their maximum: over the ~0.5s a slice spans, the average is the loudness
// envelope the ear follows, while the maximum would reinstate exactly the
// transient-dominated shape RMS was chosen to avoid.
fn bucketize(raw: &[f32]) -> Vec<u8> {
  let mut levels = Vec::with_capacity(BUCKETS);
  for bucket in 0..BUCKETS {
    let start = bucket * raw.len() / BUCKETS;
    // Tracks shorter than BUCKETS blocks map several slices onto the same
    // measurement; the `max` keeps every range non-empty so none reads as zero.
    let end = ((bucket + 1) * raw.len() / BUCKETS)
      .max(start + 1)
      .min(raw.len());
    let span = &raw[start..end];
    let mean = span.iter().copied().sum::<f32>() / span.len() as f32;
    levels.push(mean);
  }

  let reference = percentile(&levels, NORMALIZE_PERCENTILE);
  // Digital silence: nothing to normalize against.
  if reference <= 0.0 {
    return vec![0; BUCKETS];
  }

  levels
    .iter()
    .map(|level| ((level / reference).clamp(0.0, 1.0) * 255.0).round() as u8)
    .collect()
}

// The value `fraction` of the way up the sorted distribution. Used instead of
// the maximum so a lone transient can't set the scale for the whole track.
fn percentile(values: &[f32], fraction: f32) -> f32 {
  if values.is_empty() {
    return 0.0;
  }
  let mut sorted: Vec<f32> = values.to_vec();
  sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  let index = ((sorted.len() as f32 - 1.0) * fraction).round() as usize;
  sorted[index.min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
  use super::*;

  // One RMS block's worth of a constant amplitude.
  fn block(amplitude: f32) -> Vec<f32> {
    vec![amplitude; BLOCK_SAMPLES]
  }

  #[test]
  fn levels_measure_rms_per_block() {
    let mut levels = Levels::new();
    for sample in block(0.5) {
      levels.push(sample);
    }
    for sample in block(1.0) {
      levels.push(sample);
    }
    let blocks = levels.finish().unwrap();
    assert_eq!(blocks.len(), 2);
    assert!((blocks[0] - 0.5).abs() < 0.001);
    assert!((blocks[1] - 1.0).abs() < 0.001);
  }

  #[test]
  fn levels_ignore_nan_samples() {
    let mut levels = Levels::new();
    levels.push(f32::NAN);
    levels.push(0.5);
    let blocks = levels.finish().unwrap();
    assert_eq!(blocks.len(), 1);
    assert!((blocks[0] - 0.5).abs() < 0.001);
  }

  #[test]
  fn levels_from_an_empty_stream_are_none() {
    assert!(Levels::new().finish().is_none());
  }

  #[test]
  fn bucketize_normalizes_to_the_high_percentile() {
    let peaks = bucketize(&[0.1, 0.2, 0.05]);
    assert_eq!(peaks.len(), BUCKETS);
    assert_eq!(peaks.iter().copied().max(), Some(255));
  }

  #[test]
  fn bucketize_ignores_a_lone_transient_when_scaling() {
    // A track sitting at 0.5 with one sample at full scale: the body of the
    // track should still draw near full height rather than being squashed to
    // half by the outlier.
    let mut raw = vec![0.5f32; 400];
    raw[7] = 1.0;
    let peaks = bucketize(&raw);
    assert!(peaks[200] > 240, "body drew at {}", peaks[200]);
    // The outlier itself clamps rather than overflowing.
    assert_eq!(peaks[7], 255);
  }

  #[test]
  fn bucketize_keeps_quiet_and_loud_sections_distinct() {
    // A brickwalled master's peaks are pinned, but its energy is not: a verse
    // at half the energy of the chorus has to draw at roughly half height.
    let mut raw = vec![0.25f32; 200];
    raw.extend(vec![0.5f32; 200]);
    let peaks = bucketize(&raw);
    assert_eq!(peaks[BUCKETS - 1], 255);
    let quiet = peaks[100] as f32 / peaks[BUCKETS - 1] as f32;
    assert!(
      (quiet - 0.5).abs() < 0.05,
      "verse drew at {quiet} of the chorus"
    );
  }

  #[test]
  fn bucketize_spreads_short_input_over_every_bucket() {
    let peaks = bucketize(&[0.25, 0.5, 1.0]);
    assert_eq!(peaks.len(), BUCKETS);
    assert_eq!(peaks[BUCKETS - 1], 255);
  }

  #[test]
  fn bucketize_returns_silence_for_a_silent_track() {
    assert_eq!(bucketize(&[0.0, 0.0]), vec![0; BUCKETS]);
  }

  #[test]
  fn compute_peaks_gives_up_on_a_non_audio_file() {
    let path = std::env::temp_dir().join("tunediver-waveform-test.mp3");
    std::fs::write(&path, b"not actually an mp3").unwrap();
    assert!(compute_peaks(&path).is_none());
    let _ = std::fs::remove_file(&path);
  }
}
