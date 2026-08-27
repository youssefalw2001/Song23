/**
 * The domain, in one place.
 *
 * The shape of `Answers` is not invented here — it mirrors the field ids the
 * site's Create flow already collects in `lib/questions.ts`. Keeping the names
 * identical means the studio page can post what it has without translating,
 * and a mismatch shows up as a type error rather than a silently empty verse.
 */

export type Species = "dog" | "cat" | "other" | "";

/** The five options the Create flow offers for `style`. */
export type StyleChoice = "acoustic" | "piano" | "folk" | "country" | "unsure";

export type Answers = {
  /** Required. Everything else can be blank — see the note in lib/questions.ts. */
  petName: string;
  species?: Species;
  about?: string;
  personality?: string;
  /** Required. The specific, small memories. This is what the song is built from. */
  memories: string;
  include?: string;
  style?: StyleChoice;
  yourName?: string;
  email?: string;
};

export type AudioFormat = "mp3" | "wav" | "flac" | "opus" | "aac";

/**
 * A song, fully specified, ready to hand to a provider.
 *
 * This is the artefact the operator reviews and edits in /studio. Once a brief
 * looks right, generating from it is mechanical — which is the whole point of
 * separating the brief from the generation.
 */
export type SongBrief = {
  /** Working title. Not sent to the model; used for filenames and the player. */
  title: string;
  /**
   * ACE's "caption": style, instruments, timbre, vocal character, tempo feel.
   * The single most important input — the model weights this heavily.
   * Deliberately excludes bpm/key/time-signature, which have their own fields;
   * ACE's own songwriting guide says putting them here hurts.
   */
  caption: string;
  /** Structured lyrics with [Section] tags. Sent verbatim. Never truncated. */
  lyrics: string;
  durationSeconds: number;
  bpm?: number;
  /** e.g. "C Major", "Am". Common keys (C, G, D, Am, Em) are most stable. */
  keyScale?: string;
  /** "4/4", "3/4", "6/8". */
  timeSignature?: string;
  vocalLanguage: string;
};

export type GenerateRequest = SongBrief & {
  format: AudioFormat;
  /** Omit for a random take. Set to reproduce one. */
  seed?: number;
};

export type GeneratedTrack = {
  audio: Buffer;
  contentType: string;
  format: AudioFormat;
  bytes: number;
  /**
   * Derived from the bitstream, not from what we asked for. If the provider
   * quietly ignored `durationSeconds` we want to see that in the record rather
   * than trust the request.
   */
  approxDurationSeconds: number;
  /** Provider name plus whatever id it gave us, for support and log matching. */
  provider: string;
  providerId: string | null;
  /** ACE returns its 5Hz semantic tokens. Kept so a take can be re-derived. */
  audioCodes?: string;
  /** Whatever the provider said about what it actually did. */
  providerNotes?: string;
};

export type ProviderHealth = {
  ok: boolean;
  provider: string;
  detail: string;
  /** Model ids the backend admits to, when it will tell us. */
  models?: string[];
};

/**
 * "draft" is a brief that exists and has never been generated.
 *
 * It used to be called "queued", which was a lie: nothing was in the queue, and a
 * job whose generation had been rejected sat there reading "queued" forever while
 * no work was pending. The distinction matters because "draft" is the normal,
 * expected state of a new job — creating one deliberately does not generate.
 */
export type JobStatus = "draft" | "queued" | "generating" | "ready" | "failed";

export type JobAttempt = {
  startedAt: string;
  endedAt: string;
  ok: boolean;
  /** HTTP status where there was one. 0 for a transport failure. */
  status: number;
  ms: number;
  error?: string;
};

export type Job = {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;

  /** What the customer wrote. */
  answers: Answers;
  /**
   * What we're going to generate. Written at submit time from the answers, then
   * freely overwritten by the operator before generation. The brief on a job is
   * always the brief that was actually used.
   */
  brief: SongBrief;

  /** Populated once status is "ready". */
  result?: {
    audioFile: string;
    format: AudioFormat;
    bytes: number;
    approxDurationSeconds: number;
    provider: string;
    providerId: string | null;
    /** Stable per-take integer for the site's synthetic waveform. */
    seed: number;
    finishedAt: string;
  };

  /** Populated once status is "failed". */
  error?: string;

  /** Every attempt, including the ones that 504'd. Free-tier reality. */
  attempts: JobAttempt[];
  /** Bumped by /regenerate. Take 1 is rarely the one you send. */
  take: number;
};
