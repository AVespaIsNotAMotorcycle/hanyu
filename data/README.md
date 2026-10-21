# Data Pipeline

Builds the seed dataset in [`seed/`](seed/README.md) from pinned sources. Run from the repository root:

```sh
npm run data:fetch   # download sources into data/raw and check data/sources.lock.json
npm run data:build   # regenerate data/seed
npm run db:seed      # load data/seed into MongoDB (idempotent)
```

The build is deterministic: the same sources produce byte-identical output. It prints a report of match statistics and anything it had to estimate.

## Sources

Defined in [`src/sources.ts`](src/sources.ts). GitHub sources are pinned to a commit, and every pinned file's SHA-256 is in [`sources.lock.json`](sources.lock.json). After changing a source, run `npm run fetch -w data -- --force --update-lock`. CC-CEDICT can't be pinned (MDBG serves only the latest export), so its hash and date go in `seed/manifest.json`.

`data/raw` is gitignored. It includes the official HSK syllabus PDF, which must not be republished.

## HSK Source Verification

The official syllabus PDF (`hsk-syllabus.pdf`) has copying disabled, so the pipeline doesn't parse it. It uses third-party transcriptions instead, checked against the PDF:

- The word transcription names the same PDF by SHA-256 as the official download, and it has all 11,000 entries with the official per-level totals (300, 200, 500, 1,000, 1,600, 1,800, 5,600).
- 120 entries on PDF pages 80, 263, and 354 (HSK 1, 7–9, and the last page) were compared to rendered pages: IDs, level labels such as `1（4）`, homograph numbers, pinyin, and parts of speech all match.
- The HSK 1 grammar page (p. 386) and the HSK 1 认读字 page (p. 356) match the grammar and character lists. The character list transcription reads the four-column table row by row, so its order is not the syllabus order; the pipeline doesn't rely on it.

To spot-check another page: `pdftoppm -f N -l N -r 90 -png data/raw/hsk-syllabus.pdf page`, then compare with the rows in `raw/hsk-words.csv` whose `source_pdf_page` is N.

## How Records Are Built

- **Words** are matched to CC-CEDICT by pinyin, which picks the right reading for 多音字 (行 háng in 银行, xíng in 行). Citation pinyin (`citationPinyin`) takes its syllables from CC-CEDICT and its tones from the syllabus, except that printed 一/不 sandhi is undone (bú kèqi → `bu4 ke4 qi5`). Where the two disagree on a tone, the syllabus wins (下载 `xia4 zai4`).
- **Words missing from CC-CEDICT** (口哨儿, 精彩纷呈) are built from dictionary parts, with empty definitions.
- **Frequency** is wordfreq's Zipf value. For the ~30 words wordfreq lacks, it's estimated from jieba segments the way wordfreq combines tokens.
- **Ordering**: `levelOrder` ranks words within a level by frequency. A character note is introduced by the first word, in that order, that contains it.
- **Grammar points** keep the syllabus's category, name, item, and content columns.

## Segmenter

[`src/segmenter.ts`](src/segmenter.ts) wraps jieba (`@node-rs/jieba`) for the reading module's level checks. Pass the HSK vocabulary to `createSegmenter()` so syllabus words jieba doesn't know (正能量) stay whole. jieba may still group HSK words into larger known compounds (喝咖啡), so level checks split unknown tokens into known words (`src/passages/level.ts`).

## Reading Passages

`src/passages/` generates graded reading passages with Claude (`claude-sonnet-5-5`), offline. Nothing in the web app ever calls an LLM.

```sh
npm run passages:coverage                       # passages, checks, reviews, and grammar coverage per level
npm run passages:coverage -- --level 1          # every level-1 grammar point and its count
npm run passages:generate -- --level 1 --count 5 --max-cost 5
npm run passages:generate -- --level 1 --grammar g1-008,g1-020
npm run passages:generate -- --level 1 --dry-run   # print the prompts; no API call
npm run passages:check                          # segment, and run missing answer-key checks (--max-cost 1)
npm run passages:translate                      # reference translations where missing (--force redoes them)
npm run passages:review -- --sample 3           # spot-check a random sample by hand
npm run db:seed                                 # load data/passages into MongoDB
```

Generation and checking need `ANTHROPIC_API_KEY` in `.env`. Each passage:

1. **Targets grammar points.** By default, the two least-covered points at the level (`--grammar` picks them). Coverage counts the points each stored passage quotes.
2. **Is written with the level's vocabulary.** The system prompt holds the rules and every HSK word at or below the level (prompt-cached per level). The model answers through structured outputs (a JSON schema), so the reply has a fixed shape.
3. **Is checked, and sent back with the problems until it passes** (at most 3 attempts):
   - **Shape and level**: length; every target grammar point quoted exactly from the text; 3 multiple-choice questions with 4 distinct options; 3 cloze questions whose sentences match the text once filled in, with answers made of level vocabulary (at most 4 characters) and stroke data, so they can be handwritten; and the **level check**: at least 95% of hanzi tokens (passage, questions, and options) are HSK words at or below the level, compounds of them, or declared names (up to 3).
   - **Answer key** ([`src/passages/answerKey.ts`](src/passages/answerKey.ts)): a separate call sees the passage and questions without the key, answers each one, and reports problems. The check fails if it picks a different option, finds a second option defensible, fills a blank with a word the question doesn't accept, or reports a major issue. Minor issues are recorded but don't fail it.
4. **Gets a reference translation** ([`src/passages/translate.ts`](src/passages/translate.ts)): one faithful, natural English paragraph per Chinese paragraph, the model answer translation exercises are graded against. If it fails, the passage is still written; `passages:translate` fills it in later.
5. **Is segmented for tap-to-look-up** (`tokens`: jieba, with compounds split into HSK words and names kept whole; see `tokenize` in `src/passages/level.ts`).
6. **Is written to `data/passages/hsk<level>/<id>.json`** with its level check, answer-key check, and provenance (model, prompt version, attempts, cost). Delete a file to drop a passage.

`db:seed` refuses passages under the level threshold and passages that haven't passed the answer-key check. `passages:check` brings older files up to date: it always redoes the segmentation (free), and runs the answer-key check where it's missing or was made with an older `CHECK_PROMPT_VERSION` (`--force` reruns it everywhere). A failed check is recorded in the file; regenerate or delete that passage.

**Spot-checks by hand.** The automated checks come first; `passages:review` then shows a random sample of passages that passed them and haven't been reviewed (text, key, the checker's answers and issues) and asks to approve (recorded in the file's `review`, with an optional note), delete, or skip. `passages:coverage` shows how many passages at each level have been reviewed.

Costs come from the API's reported usage at Sonnet 5.5 prices (`PRICING` in `src/passages/llm.ts`). A run stops before any call that could pass `--max-cost` (default $5 for generation, $1 for checks). Answer-key checks cost under a cent each. Bump `PROMPT_VERSION` when the generation prompt or schema changes, and `CHECK_PROMPT_VERSION` when the check's does.

## Listening Exercises

`src/listening/` generates listening exercises with Claude (`claude-sonnet-5-5`), offline: one to three sentences, read aloud by the recorded voice with the text hidden, and one or two multiple-choice questions that learners read on screen.

```sh
npm run listening:coverage [-- --level 1]       # exercises, checks, reviews, and grammar coverage
npm run listening:generate -- --level 1 --count 10 --max-cost 2
npm run listening:generate -- --level 1 --dry-run   # print the prompts; no API call
npm run listening:check                         # missing answer-key checks (--force, --max-cost 1)
npm run listening:review -- --sample 3          # spot-check by hand
npm run audio:generate                          # record them (Azure)
npm run db:seed                                 # load data/listening into MongoDB
```

Each exercise targets the level's least-covered grammar point (`--grammar` picks one) and a situation unlike the level's last 40 (their `topic`s go into the prompt). It must be one paragraph of 1–3 sentences (`countSentences`) in the level's length range, by one speaker, with 4 distinct options per question and the same 95% level check as passages (text, prompts, and options). The passages' answer-key check then answers the questions from the transcript without the key, and failures go back to the model (at most 3 attempts). Files go to `data/listening/hsk<level>/l<level>-<n>.json`, with an English translation (shown as the transcript once every question is answered). `db:seed` refuses exercises under the level threshold or without a passed check. Each costs about $0.015. Bump `PROMPT_VERSION` in `src/listening/generate.ts` when its prompt or schema changes.

Clips are `listening:<id>` (the text) and `listening:<id>:q:<question>` (each prompt). `audio:generate` records them with everything else; `--no-listening` skips them.

## Translation Grader Evals

The web app grades learners' Chinese → English translations with `gradeTranslation` (`shared/src/grading.ts`, Sonnet 5.5): per-criterion scores (accuracy, completeness, grammar handling, naturalness), errors with quoted spans, and the source words the learner misunderstood. `src/grader/` checks that grader against two sets:

```sh
npm run grader:learner-set        # build grader-evals/learner.json (--max-cost 1; --force rebuilds)
npm run grader:eval               # grade both sets; writes grader-evals/results/<model>-v<version>.json (--max-cost 2)
npm run grader:consistency        # re-grade a fixed sample; writes grader-evals/consistency/ (--max-cost 0.5)
```

- **Calibration** ([`src/grader/mqm.ts`](src/grader/mqm.ts)): 40 machine translations of TED talk sentences from Google's [WMT MQM release](https://github.com/google/wmt-mqm-human-evaluation) (`mqm-ted-zhen`, pinned in `sources.ts`), rated by professional translators with error spans and severities. The sample is fixed: 10 per MQM penalty band (none, minor, one major, several), learner-length sentences, one per source segment. The annotations are Apache-2.0, but TED talk text is CC BY-NC-ND, so it stays in `data/raw`: results record only item IDs and numbers. Metrics: Spearman correlation of the grader's penalty (major 5, minor 1) and overall score with the MQM penalty, the share of MQM major errors the grader's spans cover, and the share of error-free translations given no major error.
- **Learner-style** ([`src/grader/learnerSet.ts`](src/grader/learnerSet.ts)): for each passage paragraph, the reference translation with two injected errors (wrong tense, dropped clause, mistranslated word, wrong number/time/person, round-robin), whose quoted spans are the answer key, and a faithful paraphrase that should get no major errors (the reference isn't the only right answer). Built once with Sonnet 5.5 and reviewed in git. Metrics: the share of injected errors the grader's spans cover (by translation or source span), the share of paraphrases with no major error, and mean overall scores for each kind.

**When the grading prompt or model changes**, bump `GRADER_PROMPT_VERSION` and run `grader:eval`: `test/grader.test.ts` fails until results exist for the current model and version, and comparing results files shows what the change did. **Every so often** (say monthly, or when the API model behind the name might have changed), run `grader:consistency`: it re-grades the first 5 items of each set and reports how far overall scores moved from the eval run.

Results for `claude-sonnet-5-5`, prompt v1 (October 2026, $0.74): calibration penalty Spearman 0.34 (score 0.22), MQM major-error span recall 61%, every error-free translation free of major errors; learner-style injected-error recall 90%, 95% of paraphrases free of major errors, mean overall 3.97 (injected) vs 4.85 (paraphrase). The grader is more lenient than MQM raters, who mark many awkward-style issues as major. A consistency run moved overall scores by 0.06 on average.

## Recorded Audio

`npm run audio:generate` records read-aloud clips with Azure neural text-to-speech (voice `AUDIO_VOICE` in `shared/src/audio.ts`, `zh-CN-XiaoxiaoNeural`): every passage's title, paragraphs, and question sentences, every listening exercise's text and questions, every HSK word, and the settings page's sample. It needs `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` in `.env`. Clips go to `data/audio/clips/<hash>.mp3` with `data/audio/manifest.json`, both committed (about 125 MB) so any checkout can seed them; `npm run db:seed` loads them into MongoDB, writing only clips that changed. They're left out of the Heroku slug (`.slugignore`), so seed production from a checkout with `MONGODB_URI` set to Atlas. Re-recording everything (a new voice) adds the whole set to git history again, so switch voices sparingly.

- **What gets recorded again:** a clip whose text, forced pinyin, voice, or format changed, or whose file is missing. Runs save as they go, so an interrupted run resumes. `--levels 1,2` narrows it, and `--no-words`/`--no-passages` skip a kind. `--dry-run` prints the count and cost estimate.
- **Cost:** Azure bills each Chinese character as two. Everything is about 47,000 billed characters, under $1 at list price and within the free tier's monthly allowance. Runs stop above `--max-cost` (default $2).
- **Speed:** the free tier (F0) allows 20 requests a minute, so all 11,000 words take about nine hours there (HSK 1 takes about 20 minutes). The standard tier (S0) allows 30 a second and takes minutes. The script waits out rate limits either way.
- **Readings:** a word read more than one way across the word list (行 xíng and háng; 125 of them) gets its citation pinyin forced through SSML (`<phoneme alphabet="sapi" ph="hang 2">`), so each entry says its own reading. Other words are left to the voice, which gets tone sandhi right.
- **Trying a voice:** `npm run audio:sample -- 银行 --voice zh-CN-YunxiNeural --pinyin 'yin2 hang2'` writes `data/audio/sample.mp3`. Azure's voice gallery lists the zh-CN voices. To switch, change `AUDIO_VOICE`; every clip is then recorded again.
