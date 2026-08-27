/**
 * Read the duration back out of the audio we were given.
 *
 * We ask for a duration; we do not assume we got it. The hosted endpoint has a
 * documented bug where `duration` is silently dropped and replaced by a
 * model-chosen default (ace-step/ACE-Step-1.5#1215 — it happens whenever the
 * request isn't wrapped in explicit <prompt>/<lyrics> tags). We work around the
 * bug in the adapter, but the check stays: if a customer is promised a
 * three-minute song, something should be measuring the file rather than the
 * intent.
 *
 * ffmpeg would do this in one line. It's also 80MB and a system dependency for
 * a service whose entire job is one HTTP call, so: parse the container.
 */

const MPEG_BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0];
const SAMPLE_RATES_V2 = [22050, 24000, 16000, 0];
const SAMPLE_RATES_V25 = [11025, 12000, 8000, 0];

export type AudioProbe = {
  approxDurationSeconds: number;
  detail: string;
};

/** Length of an ID3v2 tag at the head of the buffer, or 0. */
function id3Length(buf: Buffer): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // "ID3"
  // Syncsafe integer: 7 bits per byte.
  const size =
    ((buf[6]! & 0x7f) << 21) |
    ((buf[7]! & 0x7f) << 14) |
    ((buf[8]! & 0x7f) << 7) |
    (buf[9]! & 0x7f);
  return 10 + size;
}

/**
 * Walk the MPEG frame headers and sum the frames.
 *
 * Frame-counting rather than `bytes / bitrate` because the latter is wrong for
 * VBR and silently wrong for a file with a big ID3 tag or album art.
 */
function probeMp3(buf: Buffer): AudioProbe | null {
  let i = id3Length(buf);
  let frames = 0;
  let samples = 0;
  let sampleRate = 0;
  let bitrateSum = 0;
  const start = i;

  while (i < buf.length - 4) {
    const b0 = buf[i]!;
    const b1 = buf[i + 1]!;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }

    const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
    if (layerBits !== 1) {
      i += 1;
      continue;
    }

    const b2 = buf[i + 2]!;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;

    const rates =
      versionBits === 3 ? SAMPLE_RATES_V1 : versionBits === 2 ? SAMPLE_RATES_V2 : SAMPLE_RATES_V25;
    const bitrates = versionBits === 3 ? MPEG_BITRATES_V1_L3 : MPEG_BITRATES_V2_L3;

    const rate = rates[sampleRateIndex] ?? 0;
    const kbps = bitrates[bitrateIndex] ?? 0;
    if (!rate || !kbps) {
      i += 1;
      continue;
    }

    // MPEG1 Layer III is 1152 samples per frame; MPEG2/2.5 is 576.
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLength = Math.floor((samplesPerFrame / 8) * (kbps * 1000) / rate) + padding;
    if (frameLength <= 4) {
      i += 1;
      continue;
    }

    frames += 1;
    samples += samplesPerFrame;
    sampleRate = rate;
    bitrateSum += kbps;
    i += frameLength;
  }

  if (!frames || !sampleRate) return null;

  const seconds = samples / sampleRate;
  const avgKbps = Math.round(bitrateSum / frames);
  return {
    approxDurationSeconds: Math.round(seconds * 10) / 10,
    detail: `mp3 ${frames} frames, ${sampleRate}Hz, ~${avgKbps}kbps, ${
      start ? `${start}B id3 tag` : "no id3 tag"
    }`,
  };
}

/** RIFF/WAVE: read fmt and data chunk sizes. */
function probeWav(buf: Buffer): AudioProbe | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      // A streamed wav can carry size 0 or 0xFFFFFFFF; fall back to what's left.
      dataSize = size > 0 && body + size <= buf.length ? size : buf.length - body;
      break;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!dataSize) return null;
  const rate = byteRate || (sampleRate * channels * bits) / 8;
  if (!rate) return null;

  return {
    approxDurationSeconds: Math.round((dataSize / rate) * 10) / 10,
    detail: `wav ${sampleRate}Hz, ${channels}ch, ${bits}-bit`,
  };
}

/** FLAC STREAMINFO carries the total sample count outright. */
function probeFlac(buf: Buffer): AudioProbe | null {
  if (buf.length < 42) return null;
  if (buf.toString("ascii", 0, 4) !== "fLaC") return null;
  // STREAMINFO is always the first metadata block, body starts at byte 8.
  const b = buf.subarray(8);
  if (b.length < 18) return null;
  const sampleRate = (b[10]! << 12) | (b[11]! << 4) | (b[12]! >> 4);
  const totalSamples =
    (b[13]! & 0x0f) * 2 ** 32 + (b[14]! << 24) + (b[15]! << 16) + (b[16]! << 8) + b[17]!;
  if (!sampleRate || !totalSamples) return null;
  return {
    approxDurationSeconds: Math.round((totalSamples / sampleRate) * 10) / 10,
    detail: `flac ${sampleRate}Hz`,
  };
}

export function probeAudio(buf: Buffer): AudioProbe {
  return (
    probeWav(buf) ??
    probeFlac(buf) ??
    probeMp3(buf) ?? { approxDurationSeconds: 0, detail: "unrecognised container" }
  );
}

/**
 * Cheap "is this actually music" check.
 *
 * A generation failure that returns a well-formed file of silence is worse than
 * an error, because it looks like success. Compressed audio is high-entropy and
 * non-repetitive; silence and stuck loops are neither. This won't catch a bad
 * take, but it catches a broken one.
 */
export function looksLikeAudio(buf: Buffer): { ok: boolean; detail: string } {
  if (buf.length < 8_000) return { ok: false, detail: `only ${buf.length} bytes` };

  const blockSize = 128;
  const blocks = new Set<string>();
  let counted = 0;
  for (let i = 0; i + blockSize < buf.length; i += blockSize) {
    blocks.add(buf.toString("latin1", i, i + blockSize));
    counted += 1;
  }
  const uniqueness = counted ? blocks.size / counted : 0;

  const histogram = new Array<number>(256).fill(0);
  for (const byte of buf) histogram[byte]! += 1;
  let entropy = 0;
  for (const count of histogram) {
    if (!count) continue;
    const p = count / buf.length;
    entropy -= p * Math.log2(p);
  }

  const detail = `uniqueness=${(uniqueness * 100).toFixed(1)}% entropy=${entropy.toFixed(2)}/8`;
  return { ok: uniqueness > 0.9 && entropy > 7.0, detail };
}
