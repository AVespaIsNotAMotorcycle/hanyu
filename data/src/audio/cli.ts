// Recorded audio CLI (Azure neural text-to-speech).
//
//   npm run audio:generate [-- --levels 1,2] [--no-words] [--no-passages]
//                          [--no-listening] [--max-cost 2] [--concurrency 4] [--dry-run]
//   npm run audio:sample -- 你好 [--voice zh-CN-YunxiNeural] [--pinyin 'ni3 hao3']
//   npm run audio:status
//
// Needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (in .env). Clips go to
// data/audio (committed); `npm run db:seed` loads them into MongoDB.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AUDIO_SAMPLE,
  AUDIO_VOICE,
  audioKeys,
  HSK_LEVELS,
  isHskLevel,
  listeningClips,
  passageClips,
  wordClips,
  type ClipSpec,
  type HskLevel,
} from '@hanyu/shared';
import { loadSeedContent } from '../passages/content.js';
import { readExercises } from '../listening/library.js';
import { readPassages } from '../passages/library.js';
import {
  billedCharacters,
  createAzureTts,
  ssmlFor,
  USD_PER_MILLION,
  type Tts,
} from './azure.js';
import { audioDir, missingClips, readManifest } from './library.js';
import { recordClips } from './record.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    levels: { type: 'string' },
    'no-words': { type: 'boolean', default: false },
    'no-passages': { type: 'boolean', default: false },
    'no-listening': { type: 'boolean', default: false },
    'max-cost': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
    voice: { type: 'string', default: AUDIO_VOICE },
    pinyin: { type: 'string' },
  },
});
const command = positionals[0];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function azure(): Tts {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    fail('Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (in .env).');
  }
  return createAzureTts({ key, region });
}

function levelsArg(): HskLevel[] {
  if (!values.levels) return [...HSK_LEVELS];
  const levels = values.levels.split(',').map(Number);
  if (!levels.every(isHskLevel)) fail('--levels must be 1 to 7, e.g. 1,2');
  return levels as HskLevel[];
}

/** Every clip for the chosen levels: passages, listening, then words. */
function allClips(levels: readonly HskLevel[]): ClipSpec[] {
  const clips: ClipSpec[] = [
    { key: audioKeys.sample, text: AUDIO_SAMPLE, pinyin: null },
  ];
  if (!values['no-passages']) {
    for (const level of levels) {
      for (const passage of readPassages(level)) {
        clips.push(...passageClips(passage));
      }
    }
  }
  if (!values['no-listening']) {
    for (const level of levels) {
      for (const exercise of readExercises(level)) {
        clips.push(...listeningClips(exercise));
      }
    }
  }
  if (!values['no-words']) {
    // Readings are compared across the whole list, so a level's homographs
    // know about the other levels' readings.
    const { words } = loadSeedContent();
    const wanted = new Set(
      words.filter((w) => levels.includes(w.level)).map((w) => w._id),
    );
    clips.push(...wordClips(words).filter((c) => wanted.has(c.key.slice(5))));
  }
  return clips;
}

const dollars = (characters: number) =>
  (characters / 1_000_000) * USD_PER_MILLION;

if (command === 'generate') {
  // Always the app's voice, so every clip sounds the same (change
  // AUDIO_VOICE in shared/src/audio.ts to switch; everything re-records).
  const voice = AUDIO_VOICE;
  const cap = Number(values['max-cost']);
  const concurrency = Number(values.concurrency);
  if (!(cap > 0)) fail('--max-cost must be above 0');
  if (!(concurrency >= 1)) fail('--concurrency must be at least 1');
  const levels = levelsArg();
  const clips = allClips(levels);
  const todo = missingClips(clips, readManifest(), voice);
  const characters = todo.reduce((n, c) => n + billedCharacters(c), 0);
  const estimate = dollars(characters);
  console.log(
    `${clips.length} clips for HSK ${levels.join(', ')} (${voice}); ` +
      `${todo.length} to record, ${characters} billed characters, ` +
      `about $${estimate.toFixed(2)} at $${USD_PER_MILLION}/million ` +
      `(on the free tier, within its monthly allowance).`,
  );
  if (!todo.length || values['dry-run']) process.exit(0);
  if (estimate > cap) {
    fail(`That's over --max-cost $${cap}. Raise it, or narrow with --levels.`);
  }
  const started = Date.now();
  let lastLog = 0;
  const result = await recordClips({
    clips: todo,
    tts: azure(),
    voice,
    concurrency,
    onProgress(done, total) {
      if (Date.now() - lastLog > 5000 || done === total) {
        lastLog = Date.now();
        const rate = done / ((Date.now() - started) / 1000);
        const left = rate > 0 ? Math.round((total - done) / rate / 60) : 0;
        console.log(
          `  ${done}/${total} (${rate.toFixed(1)}/s${done < total ? `, ~${left} min left` : ''})`,
        );
      }
    },
  });
  console.log(
    `Recorded ${result.recorded} clips (${result.billedCharacters} billed characters, ` +
      `about $${dollars(result.billedCharacters).toFixed(2)}) into ${path.relative(process.cwd(), audioDir) || audioDir}.`,
  );
  if (result.failures.length) {
    for (const f of result.failures.slice(0, 10)) {
      console.error(`  ${f.key}: ${f.error}`);
    }
    fail(
      `${result.failures.length} failed${result.failures.length > 10 ? ' (first 10 shown)' : ''}; run again to retry them.`,
    );
  }
  console.log('Load them with npm run db:seed.');
} else if (command === 'sample') {
  // Try a voice or a reading before recording everything with it.
  const text = positionals.slice(1).join('') || AUDIO_SAMPLE;
  const clip: ClipSpec = { key: 'sample', text, pinyin: values.pinyin ?? null };
  const audio = await azure().synthesize(ssmlFor(clip, values.voice));
  const file = path.join(audioDir, 'sample.mp3');
  mkdirSync(audioDir, { recursive: true });
  writeFileSync(file, audio);
  console.log(`Wrote ${file} (${values.voice}).`);
} else if (command === 'status') {
  const manifest = readManifest();
  const clips = allClips(levelsArg());
  const todo = missingClips(clips, manifest, AUDIO_VOICE);
  const bytes = Object.values(manifest.clips).reduce((n, c) => n + c.bytes, 0);
  console.log(
    `${clips.length - todo.length}/${clips.length} clips recorded with ${AUDIO_VOICE} ` +
      `(${(bytes / 1e6).toFixed(1)} MB on disk); ${todo.length} missing or out of date.`,
  );
} else {
  fail('Usage: cli.ts generate|sample|status (see the top of this file)');
}
