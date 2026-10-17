# Chinese Learning App Roadmap

A personal app for learning to read Chinese, starting with modern Mandarin in simplified characters and working toward traditional characters and Classical Chinese. Built as a MERN app (MongoDB, Express, React, Node.js) deployed to a single Heroku dyno.

## Goals

- Spaced-repetition flashcards organized by HSK level, requiring handwritten characters and typed pinyin
- Graded reading passages with multiple-choice and fill-in-the-blank comprehension questions
- Translation challenges graded by an LLM, with structured feedback
- Long term: fluent reading of traditional characters and Classical Chinese

## Foundational Decisions

These should be settled before writing code, because they shape the data model.

### Multi-User, Sign-In Required

The app is built around one learner's needs but is open to anyone. Every route except sign-in requires authentication, which also keeps the LLM endpoints from being used by strangers. Every card, review log, and grading record carries a `userId`.

Accounts use an email and password, with server-side sessions in an `HttpOnly` cookie (decided October 2026; OAuth can be added later).

### Sync Review Logs, Not Card State

Reviews are recorded as an append-only stream of review-log events. Clients sync logs, not card state, and FSRS state is recomputed from the logs. Merging offline reviews from multiple devices is then a union of events, with no conflict resolution.

### Use HSK 3.0 Word Lists

HSK 3.0 (nine levels in three stages) replaced HSK 2.0 worldwide in July 2026. Source the word lists from the official syllabus released in November 2025, not from third-party copies, which disagree on some per-level counts.

The official PDF has copying disabled, so the pipeline uses transcriptions of that exact PDF (matched by SHA-256) that have the official per-level totals, and spot-checks them against rendered pages. See `data/README.md`.

### Store Traditional Forms From Day One

Every word record carries both simplified and traditional forms, even while only simplified is displayed. Adding traditional characters later then becomes a display toggle and a new card type rather than a migration.

### Model Multiple Readings Correctly

Attach readings to words, not characters, so that 多音字 such as 行 (xíng / háng) are graded against the correct pronunciation in context.

### Separate Character Notes From Word Notes

HSK lists are word lists, but handwriting happens one character at a time.

| Note type | Cards generated                        | Introduced when                                       |
| --------- | -------------------------------------- | ----------------------------------------------------- |
| Word      | Pinyin production, meaning/recognition | The word's HSK level is unlocked                      |
| Character | Handwriting                            | The first word containing the character is introduced |

This way, 学 is drawn once as its own card rather than separately inside 学生, 学习, and 大学.

### Card Prompts

- Handwriting cards show the pinyin and an English gloss.
- When the requested character is part of a multi-character word, the other characters are shown with a blank in place of the requested one (e.g., 学\_ with _xuésheng_, "student").

### Ordering and Leeches

- New cards within a level are introduced in order of word frequency.
- Cards failed repeatedly are flagged as leeches, and a study mode trains only on flagged cards.

## Phase 0: Data Pipeline

Estimated time: 1–2 weeks

- [x] Import HSK 3.0 word lists, tagged by level
- [x] Import HSK 3.0 grammar points, tagged by level
- [x] Import a word-frequency list (e.g., SUBTLEX-CH, after checking its license) to order new cards (wordfreq, CC BY-SA 4.0, which includes SUBTLEX-CH; SUBTLEX-CH alone is licensed for research only)
- [x] Import CC-CEDICT for pinyin, English definitions, and traditional forms
- [x] Import Make Me a Hanzi for stroke paths, stroke-order medians, and character decomposition
- [x] Set up a word segmenter (e.g., jieba) for later use in the reading module
- [x] Generate word notes and character notes from the merged data
- [x] Output a versioned JSON seed dataset committed to the repository
- [x] Define Mongoose schemas for users, words, characters, cards, append-only review logs, and grammar points
- [x] Write an idempotent seed script that loads the dataset into MongoDB Atlas

## Phase 1: SRS Core With Pinyin Input (MVP)

- [x] Scaffold the Express API and React client in one repository
- [x] Add sign-up, sign-in, and authentication middleware on every API route
- [x] Deploy to Heroku early: one dyno where Express serves both the API and the React production build
- [x] Implement scheduling with FSRS (`ts-fsrs` for TypeScript)
- [x] Build a pinyin answer field that:
  - Accepts tone numbers (`xue2sheng5`) and renders them as diacritics
  - Is lenient about spacing and the neutral tone
  - Grades against citation tones, not tone sandhi
- [ ] Map typed answers to FSRS grades automatically:
  - Fully correct → Good
  - Tone error only → Hard
  - Wrong syllable → Again
- [ ] Add per-level decks, daily new-card limits, and a review queue
- [ ] Record each review as an immutable log entry, and recompute card state from the logs
- [ ] Sync logs between IndexedDB and MongoDB
- [ ] Flag leeches and add a flagged-cards-only study mode
- [ ] Begin daily use and log UX friction

**Milestone:** usable daily for HSK 1 vocabulary review.

## Phase 2: Handwriting Cards

- [ ] Integrate hanzi-writer quiz mode, which checks each stroke against Make Me a Hanzi data and enforces stroke order
- [ ] Define strictness settings (stroke-order enforcement, number of allowed misses)
- [ ] Map missed strokes and hint usage to FSRS grades
- [ ] Ship as a PWA and test on a tablet with a stylus

**Milestone:** handwriting reviews feel natural enough to do every day.

## Phase 3: Reading Passages

- [ ] Generate passages offline with an LLM, targeting a specific HSK level and specific grammar points from that level
- [ ] Tag each passage with the grammar points it exercises, and track coverage per level
- [ ] Verify each passage's level with the segmenter: compute the share of tokens at or below the target level and reject passages under ~95%
- [ ] Generate multiple-choice and cloze questions alongside each passage
- [ ] Let the user answer cloze questions by keyboard or by handwriting, switchable per question
- [ ] Review and store passages and questions; never generate at request time
- [ ] Use automated checks first (level verification, an LLM answer-key check), and spot-check a sample by hand
- [ ] Add tap-to-look-up on any word, with an "add to SRS" action
- [ ] Recommend passages based on SRS state, favoring passages made mostly of known vocabulary

**Milestone:** a library of verified passages for HSK 1–3.

## Phase 4: Translation Challenges

- [ ] Start with Chinese → English, matching the reading-first goal
- [ ] Build an LLM grading endpoint that receives:
  - The source passage
  - A reference translation
  - A fixed rubric: accuracy, completeness, grammar handling, naturalness
- [ ] Require structured JSON output with per-criterion scores and quoted spans identifying each error
- [ ] Route all LLM calls through the Express API so API keys stay off the client
- [ ] Log every grading result
- [ ] Build a grader eval set:
  - Calibration: Chinese → English segments from Google's WMT MQM release, whose translations professional translators annotated with error spans and severities
  - Learner-style: reference translations of in-app passages with deliberately injected errors (wrong tense, dropped clause, mistranslated word), where the injected errors are the answer key
- [ ] Run the eval set whenever the grading prompt or model changes
- [ ] Re-grade a fixed sample set periodically to check grader consistency
- [ ] Send mistranslated words directly into the SRS queue
- [ ] Later: add English → Chinese for production practice

**Milestone:** consistent, actionable feedback on HSK 1–3 translation exercises.

## Phase 5: Traditional Characters

- [ ] Add a simplified/traditional display toggle
- [ ] Add traditional handwriting cards, checking Make Me a Hanzi coverage for traditional forms
- [ ] Convert reading passages with OpenCC
- [ ] Drill only characters whose traditional form differs from the simplified form, treating traditional as a delta rather than a second full curriculum

## Phase 6: Classical Chinese

HSK does not cover Classical Chinese, so this phase requires its own curriculum.

- [ ] Build a separate vocabulary track centered on single characters and function words (之, 其, 而, 以, 者, 也, 焉)
- [ ] Flag characters whose classical meaning differs from the modern one (e.g., 走 meaning "run")
- [ ] Assemble a graded reading sequence from public-domain texts (ctext.org, Wikisource) rather than generated passages
- [ ] Rely more heavily on reference translations when grading, since LLMs are weaker on Classical Chinese than on modern Mandarin

## Licensing

Licenses apply whether or not the app charges money.

| Source                                             | License                                               | Obligation                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CC-CEDICT                                          | CC BY-SA                                              | Credit CC-CEDICT; any redistributed dictionary data derived from it must be shared under the same license                                        |
| Make Me a Hanzi `graphics.txt` / hanzi-writer data | Arphic Public License (stroke data from Arphic fonts) | Include the license text; modified stroke data stays under the same license                                                                      |
| Make Me a Hanzi `dictionary.txt`                   | LGPL-3.0-or-later (derived from Unihan and CJKlib)    | Include the license text; modified decomposition and etymology data stays under the same license                                                 |
| wordfreq data                                      | CC BY-SA 4.0 (includes SUBTLEX-CH)                    | Credit wordfreq and the SUBTLEX-CH authors, and make clear SUBTLEX is freely available data; share derived frequency data under the same license |
| jieba dictionary and `@node-rs/jieba`              | MIT                                                   | Keep the copyright notice                                                                                                                        |
| hanzi-writer code                                  | MIT                                                   | Keep the copyright notice                                                                                                                        |
| HSK 3.0 syllabus                                   | Published by the Chinese government                   | Use the word and grammar lists as reference data; don't republish the syllabus document                                                          |
| ctext.org                                          | Site terms restrict systematic downloading            | Source Classical texts from Wikisource or other public-domain copies, not bulk downloads from ctext                                              |

- [ ] Add a credits page listing every data source and its license
- [x] Confirm the exact license version in each downloaded file's header (see `data/seed/README.md` and `data/seed/LICENSES/`)

## Open Decisions

- LLM provider and model for passage generation and grading
- Monthly LLM budget, and per-user rate limits on grading

## Technical Stack

| Layer         | Choice                                                              |
| ------------- | ------------------------------------------------------------------- |
| Frontend      | React + TypeScript, installable PWA                                 |
| Backend       | Node.js + Express REST API (LLM calls, sync, content)               |
| Database      | MongoDB Atlas via Mongoose                                          |
| Offline cache | IndexedDB on the client, synced to MongoDB, so reviews work offline |
| Hosting       | Single Heroku dyno serving the API and the React build              |
| Scheduling    | FSRS via `ts-fsrs`, shared between client and server                |
| Handwriting   | hanzi-writer + Make Me a Hanzi                                      |
| Dictionary    | CC-CEDICT                                                           |
| Conversion    | OpenCC                                                              |

## Deployment Notes

- Heroku no longer offers a first-party MongoDB add-on, so use MongoDB Atlas and pass its connection string as the `MONGODB_URI` config var
- Store LLM API keys as Heroku config vars, never in the client bundle
- The dyno filesystem is ephemeral: keep generated passages, grading logs, and all other persistent data in MongoDB, not on disk
- Run the content-generation and passage-verification scripts locally or as one-off dynos (`heroku run`), not inside web requests
- Build the React client in Heroku's build step (`heroku-postbuild`) and have Express serve the static output

## References

- [HSK 3.0 2026: Complete Guide (HSKLord)](https://hsklord.com/blog/hsk-3-2026-complete-guide)
- [HSK 3.0 vs HSK 2.0 Comparison (HSKLord)](https://hsklord.com/blog/hsk-3-0-vs-2-0-comparison)
- [CC-CEDICT](https://cc-cedict.org/)
- [Make Me a Hanzi](https://github.com/skishore/makemeahanzi)
- [Hanzi Writer](https://hanziwriter.org/)
- [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
- [OpenCC](https://github.com/BYVoid/OpenCC)
- [Chinese Text Project](https://ctext.org/)
- [WMT MQM Human Evaluation (Google)](https://github.com/google/wmt-mqm-human-evaluation)
- [Wikisource (Chinese)](https://zh.wikisource.org/)
