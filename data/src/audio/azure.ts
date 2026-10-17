// Azure neural text-to-speech over its REST API (no SDK needed): one SSML
// request per clip, retried when Azure rate-limits (the free tier allows 20
// requests a minute; standard, 30 a second).

import {
  AUDIO_FORMAT,
  AUDIO_LOCALE,
  sapiPinyin,
  type ClipSpec,
} from '@hanyu/shared';

/** Synthesizes SSML to audio in AUDIO_FORMAT. */
export interface Tts {
  synthesize(ssml: string): Promise<Uint8Array>;
}

/**
 * Approximate list price for neural voices, in USD per million billed
 * characters. Azure bills each Chinese character as two. Check
 * https://azure.microsoft.com/pricing/details/cognitive-services/speech-services
 * (the free tier's monthly allowance covers this app's clips).
 */
export const USD_PER_MILLION = 16;

/** Billed characters for a clip: two per Chinese character. */
export function billedCharacters(clip: ClipSpec): number {
  return [...clip.text].reduce(
    (n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1),
    0,
  );
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c]!,
  );

/** The SSML for one clip, with its pinyin forced when it has one. */
export function ssmlFor(clip: ClipSpec, voice: string): string {
  const sapi = clip.pinyin ? sapiPinyin(clip.pinyin) : null;
  if (clip.pinyin && !sapi) {
    throw new Error(`${clip.key}: can't convert pinyin ${clip.pinyin}`);
  }
  const body = sapi
    ? `<phoneme alphabet="sapi" ph="${sapi}">${escapeXml(clip.text)}</phoneme>`
    : escapeXml(clip.text);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${AUDIO_LOCALE}">` +
    `<voice name="${voice}">${body}</voice></speak>`
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createAzureTts({
  key,
  region,
  maxAttempts = 8,
  fetchImpl = fetch,
  wait = sleep,
}: {
  key: string;
  region: string;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}): Tts {
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  return {
    async synthesize(ssml) {
      for (let attempt = 1; ; attempt++) {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AUDIO_FORMAT,
            'User-Agent': 'hanyu-audio',
          },
          body: ssml,
        });
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          const detail = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(
            `Azure TTS ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
          );
        }
        // Retry-After is in seconds; otherwise back off exponentially.
        const after = Number(res.headers.get('retry-after'));
        await wait(
          after > 0 ? after * 1000 : Math.min(60_000, 1000 * 2 ** attempt),
        );
      }
    },
  };
}
