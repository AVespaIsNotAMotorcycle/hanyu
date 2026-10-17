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
npm run passages:coverage                       # passages and grammar coverage per level
npm run passages:coverage -- --level 1          # every level-1 grammar point and its count
npm run passages:generate -- --level 1 --count 5 --max-cost 5
npm run passages:generate -- --level 1 --grammar g1-008,g1-020
npm run passages:generate -- --level 1 --dry-run   # print the prompts; no API call
npm run db:seed                                 # load data/passages into MongoDB
```

Generation needs `ANTHROPIC_API_KEY` in `.env`. Each passage:

1. **Targets grammar points.** By default, the two least-covered points at the level (`--grammar` picks them). Coverage counts the points each stored passage quotes.
2. **Is written with the level's vocabulary.** The system prompt holds the rules and every HSK word at or below the level (prompt-cached per level). The model answers through a `submit_passage` tool, so the output is structured.
3. **Is checked, and sent back with the problems until it passes** (at most 3 attempts): length; every target grammar point quoted exactly from the text; 3 multiple-choice questions with 4 distinct options; 3 cloze questions whose sentences match the text once filled in, with answers made of level vocabulary (at most 4 characters) and stroke data, so they can be handwritten; and the **level check**: at least 95% of hanzi tokens (passage, questions, and options) are HSK words at or below the level, compounds of them, or declared names (up to 3).
4. **Is written to `data/passages/hsk<level>/<id>.json`** with its verification numbers and provenance (model, prompt version, attempts, cost). Review passages in git before loading them; delete a file to drop a passage.

Costs come from the API's reported usage at Sonnet 5.5 prices (`PRICING` in `generate.ts`). A run stops before any call that could pass `--max-cost` (default $5). Bump `PROMPT_VERSION` when the prompt or schema changes.
