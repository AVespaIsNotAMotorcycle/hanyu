import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AUDIO_SAMPLE, AUDIO_VOICE, audioKeys } from '@hanyu/shared';
import { loadClip } from './local/audio';

// Reading Chinese aloud. Recorded clips (Azure neural voice, generated
// offline and served by /api/audio) come first; text without a recording is
// read by the device's own voice (Web Speech API), which works offline
// where one is installed (iPadOS and macOS; desktop Chrome's Google voices
// need a connection).

/** A voice's rank: 0 mainland Mandarin, 1 other Mandarin; null otherwise. */
function rank(voice: SpeechSynthesisVoice): number | null {
  const lang = voice.lang.replace('_', '-').toLowerCase();
  // Cantonese voices would read Mandarin text with Cantonese sounds.
  if (/^(yue|zh-hk)/.test(lang)) return null;
  if (lang === 'zh-cn' || lang.startsWith('zh-hans') || lang === 'cmn-cn')
    return 0;
  if (lang.startsWith('zh') || lang.startsWith('cmn')) return 1;
  return null;
}

/**
 * The device's Mandarin voices, best first: mainland before others, and
 * local voices (offline, quicker to start) before online ones.
 */
export function mandarinVoices(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice[] {
  const score = (v: SpeechSynthesisVoice) =>
    rank(v)! * 2 + (v.localService ? 0 : 1);
  return voices
    .filter((v) => rank(v) !== null)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => score(a.v) - score(b.v) || a.i - b.i)
    .map(({ v }) => v);
}

/** The chosen voice if the device still has it, else the best one. */
export function pickChineseVoice(
  voices: readonly SpeechSynthesisVoice[],
  chosenUri: string | null = null,
): SpeechSynthesisVoice | null {
  const mandarin = mandarinVoices(voices);
  return mandarin.find((v) => v.voiceURI === chosenUri) ?? mandarin[0] ?? null;
}

/**
 * Splits text after each sentence-ending mark or line break, since Chrome's
 * online voices stop partway through long utterances.
 */
export function sentences(text: string): string[] {
  const parts = text.match(/[^。！？!?\n]+[。！？!?”」]*|\n+/g) ?? [];
  const out = parts.map((p) => p.trim()).filter(Boolean);
  return out.length ? out : [text];
}

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;
}

// Preferences for this device, shared by every button and settings control.
// The voice is RECORDED (the default), DEVICE (the device's best voice), or a
// device voice's URI.
const VOICE_KEY = 'hanyu.voice';
const SLOW_KEY = 'hanyu.speakSlowly';
const RECORDED = 'recorded';
const DEVICE = 'device';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let prefs = {
  voice: load(VOICE_KEY) || RECORDED,
  slow: load(SLOW_KEY) === '1',
};
const listeners = new Set<() => void>();

function setPrefs(change: Partial<typeof prefs>) {
  prefs = { ...prefs, ...change };
  try {
    localStorage.setItem(VOICE_KEY, prefs.voice);
    localStorage.setItem(SLOW_KEY, prefs.slow ? '1' : '0');
  } catch {
    // Only the preference is lost.
  }
  for (const listener of listeners) listener();
}

function usePrefs() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => prefs,
  );
}

/** The device's voices; empty while they load or without speech support. */
function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(
    () => synth()?.getVoices() ?? [],
  );
  useEffect(() => {
    const speech = synth();
    if (!speech) return;
    // Chrome loads voices asynchronously.
    const update = () => setVoices(speech.getVoices());
    update();
    speech.addEventListener('voiceschanged', update);
    return () => speech.removeEventListener('voiceschanged', update);
  }, []);
  return voices;
}

/** The device voice to read with; null while voices load or if there's none. */
function useDeviceVoice(): SpeechSynthesisVoice | null {
  const voices = useVoices();
  const { voice } = usePrefs();
  return pickChineseVoice(
    voices,
    voice === RECORDED || voice === DEVICE ? null : voice,
  );
}

/** Reads text with a device voice, a sentence at a time. */
function speakWithDevice(
  text: string,
  voice: SpeechSynthesisVoice,
): Promise<void> {
  return new Promise((resolve) => {
    const speech = synth()!;
    const utterances = sentences(text).map((sentence) => {
      const utterance = new SpeechSynthesisUtterance(sentence);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.rate = prefs.slow ? 0.6 : 0.9;
      utterance.onerror = () => resolve();
      return utterance;
    });
    utterances.at(-1)!.onend = () => resolve();
    for (const utterance of utterances) speech.speak(utterance);
  });
}

// One audio element for every clip. iOS only lets audio start from a tap,
// but an element that has played once can play again later (after a clip
// downloads), so each tap first plays a moment of silence on it.
let element: HTMLAudioElement | null = null;

function silentWav(): string {
  // 8 kHz, 8-bit mono, 100 samples of silence (128 is zero in 8-bit PCM).
  const samples = 100;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function unlockAudio(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  element ??= new Audio();
  element.src = silentWav();
  element.play().catch(() => {});
  return element;
}

function playBlob(audio: HTMLAudioElement, blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const finish = () => {
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('error', finish);
      audio.removeEventListener('pause', finish);
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.src = url;
    audio.playbackRate = prefs.slow ? 0.7 : 1;
    audio.preservesPitch = true;
    audio.play().catch(finish);
    // After the new source is set: replacing the unlocking silence can fire
    // events of its own.
    audio.addEventListener('ended', finish);
    audio.addEventListener('error', finish);
    audio.addEventListener('pause', finish);
  });
}

export interface SpeechPart {
  text: string;
  /** Recorded clip key (audioKeys); without one, the device voice reads it. */
  clip?: string;
}

interface PlayOptions {
  recorded: boolean;
  /** Null to never use the device voice (a reading it may get wrong). */
  deviceVoice: SpeechSynthesisVoice | null;
}

type Outcome = 'done' | 'stopped' | 'nothing';

// What's playing now, so starting something else stops it.
let current: { stop: () => void } | null = null;

/** Plays parts in order; calls onEnd once, however it ends. */
function play(
  parts: readonly SpeechPart[],
  { recorded, deviceVoice }: PlayOptions,
  onEnd: (outcome: Outcome) => void,
) {
  current?.stop();
  synth()?.cancel();
  const audio = recorded ? unlockAudio() : null;
  let over = false;
  const end = (outcome: Outcome) => {
    if (over) return;
    over = true;
    if (current === handle) current = null;
    onEnd(outcome);
  };
  const handle = {
    stop() {
      end('stopped');
      audio?.pause();
      synth()?.cancel();
    },
  };
  current = handle;
  void (async () => {
    let played = 0;
    for (const part of parts) {
      const blob = audio && part.clip ? await loadClip(part.clip) : null;
      if (over) return;
      if (blob) {
        await playBlob(audio!, blob);
        played++;
      } else if (deviceVoice) {
        await speakWithDevice(part.text, deviceVoice);
        played++;
      }
      if (over) return;
    }
    end(played ? 'done' : 'nothing');
  })();
  return handle;
}

/**
 * A button that reads Chinese aloud (a recording where there is one), and
 * stops if pressed again. `device={false}` keeps the device voice from
 * reading it, for words whose reading it may get wrong (行 háng); without
 * a recording the button then says so.
 */
export function SpeakButton({
  text,
  clip,
  parts,
  device = true,
  label = 'Listen',
  showLabel = false,
}: {
  text?: string;
  clip?: string;
  /** Several parts in order (a passage's title and paragraphs). */
  parts?: readonly SpeechPart[];
  device?: boolean;
  label?: string;
  showLabel?: boolean;
}) {
  const voice = useDeviceVoice();
  const { voice: choice } = usePrefs();
  const recorded = choice === RECORDED;
  const [speaking, setSpeaking] = useState(false);
  const [missing, setMissing] = useState(false);
  const handle = useRef<{ stop: () => void } | null>(null);
  const all = parts ?? [{ text: text ?? '', clip }];

  // Stop when the button goes away (next card, leaving a passage).
  useEffect(() => () => handle.current?.stop(), []);

  const deviceVoice = device ? voice : null;
  const canRecord = recorded && all.some((p) => p.clip);
  if (!canRecord && !deviceVoice) return null;

  function toggle() {
    if (speaking) {
      handle.current?.stop();
      return;
    }
    setSpeaking(true);
    handle.current = play(all, { recorded, deviceVoice }, (outcome) => {
      handle.current = null;
      setSpeaking(false);
      if (outcome === 'nothing') setMissing(true);
    });
  }

  const title = missing ? 'No recording available' : speaking ? 'Stop' : label;
  return (
    <button
      type="button"
      className="speak"
      aria-label={title}
      aria-pressed={speaking}
      title={title}
      disabled={missing}
      onClick={toggle}
    >
      {speaking ? '■' : '🔊'}
      {showLabel && <span> {speaking ? 'Stop' : label}</span>}
    </button>
  );
}

/** A checkbox for reading aloud slowly, remembered on this device. */
export function SpeakSlowlyToggle() {
  const { slow } = usePrefs();
  return (
    <label className="hint">
      <input
        type="checkbox"
        checked={slow}
        onChange={(event) => setPrefs({ slow: event.target.checked })}
      />{' '}
      Read aloud slowly
    </label>
  );
}

/** The recorded voice's name: zh-CN-XiaoxiaoNeural → Xiaoxiao. */
const recordedName = AUDIO_VOICE.replace(/^[a-z]+-[A-Z]+-|Neural$/g, '');

/** Which voice to read with, and how fast, for this device. */
export function SpeechSettings() {
  const voices = mandarinVoices(useVoices());
  const { voice: choice } = usePrefs();
  const voice = useDeviceVoice();
  const selected =
    choice === RECORDED || voices.some((v) => v.voiceURI === choice)
      ? choice
      : DEVICE;
  return (
    <fieldset className="speech-settings">
      <legend>Read aloud</legend>
      <label>
        Voice{' '}
        <select
          value={selected}
          onChange={(event) => setPrefs({ voice: event.target.value })}
        >
          <option value={RECORDED}>Recorded: {recordedName} (Azure)</option>
          {voices.length > 0 && (
            <optgroup label="This device">
              <option value={DEVICE}>
                Automatic ({voiceName(voices[0]!)})
              </option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {voiceName(v)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <span className="speak-bar">
        <SpeakButton
          key={selected}
          text={AUDIO_SAMPLE}
          clip={audioKeys.sample}
          label="Test"
          showLabel
        />
        <SpeakSlowlyToggle />
      </span>
      <p className="hint">
        {selected === RECORDED
          ? `Passages, questions, and HSK words play recordings, kept on this device once played. Anything else is read by ${voice ? 'this device’s voice' : 'nothing: this device has no Mandarin voice'}.`
          : 'For better device voices on iPad or Mac, add a Chinese voice under Settings → Accessibility → Spoken Content → Voices, then reload.'}
      </p>
    </fieldset>
  );
}

function voiceName(voice: SpeechSynthesisVoice): string {
  return `${voice.name} · ${voice.lang.replace('_', '-')}${voice.localService ? '' : ' · online'}`;
}
