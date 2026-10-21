# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Hanyu is a MERN app for learning to read Chinese. [ROADMAP.md](ROADMAP.md) is the source of truth for goals, data-model decisions, and phase order. Read its "Foundational Decisions" section before touching schemas, scheduling, or sync. Check off roadmap items as they are completed.

## Layout

npm workspaces, all TypeScript and ESM:

- `shared/` (`@hanyu/shared`): types and logic used by every workspace: seed/document shapes (`content.ts`), pinyin helpers (`pinyin.ts`), typed-answer conversion and grading (`pinyinAnswer.ts`), FSRS scheduling (`scheduling.ts`, wrapping `ts-fsrs`), the review queue (`queue.ts`: study days, due order, new-card allowance), API types. Compiled to `shared/dist`, which client and server import. After changing it, rebuild (`npm run build -w shared`) or keep `npm run dev` running.
- `server/` (`@hanyu/server`): Express 5 + Mongoose. `src/app.ts` builds the app (`createApp()`, no side effects, used by tests); `src/index.ts` connects to MongoDB and listens. Routes live in `src/routes/` and mount under `/api`. Authentication is in `src/auth/` (scrypt passwords, cookie sessions stored hashed in the `sessions` collection, `requireAuth` middleware).
- `client/` (`@hanyu/client`): React 19 + Vite. Calls the API through relative `/api/...` paths (Vite proxies to :5000 in dev; same origin in production). Installable PWA (`vite-plugin-pwa`): the service worker precaches the app shell, never `/api`. Local-first: `src/local/` keeps each user's review logs and cached word content in IndexedDB (`store.ts`), syncs logs both ways (`sync.ts`), and builds the queue and decks on the device with `buildQueue`/`buildDecks` from `@hanyu/shared`. Tests use `fake-indexeddb`.
- `data/` (`@hanyu/data`): offline pipeline (run with tsx, never deployed as code) that builds `data/seed` from pinned sources in `data/raw`, generates reading passages into `data/passages` (`src/passages/`, Claude Sonnet 5.5, with level verification, an answer-key check, and reference translations), generates listening exercises into `data/listening` (`src/listening/`, reusing the level and answer-key checks), evaluates the translation grader (`src/grader/`, results in `data/grader-evals`), and records read-aloud audio (`src/audio/`, Azure TTS, into `data/audio`). Read `data/README.md` before changing it.

Models live in `server/src/models/`. Content collections (words, characters, grammar points) use stable string `_id`s from the dataset (`hsk30-00001`, `学`, `g1-001`) so user data can reference them across reseeds. `server/src/seed.ts` loads `data/seed` idempotently.

## Commands

```sh
npm run dev         # everything in watch mode (needs MongoDB: npm run db:up)
npm test            # vitest everywhere (supertest in server/test, fake-indexeddb in client)
npm run typecheck   # tsc across workspaces
npm run build       # shared → server → client
npm run format      # prettier
npm run db:seed     # load data/seed into MongoDB
npm run data:fetch && npm run data:build   # rebuild data/seed from sources
```

Before finishing a change, run `npm run typecheck` and `npm test`. Database integration tests (`server/test/seed.test.ts`, the auth flow in `server/test/auth.test.ts`) run only with `MONGODB_TEST_URI` set, e.g. `MONGODB_TEST_URI=mongodb://localhost:27017 npm test -w server`.

## Conventions

- Server imports use NodeNext resolution: relative imports need a `.js` extension (`./db.js`). The client uses bundler resolution without extensions.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Put request/response types in `shared/` so client and server agree.
- API errors are JSON: `{ "error": "message" }`.
- Express 5 catch-all routes use `'/{*splat}'`, and async handlers can throw (errors reach the error handler).
- Add a supertest test in `server/test/` for each new route, using `createApp()`. Protected routes need a session and therefore a database: sign up with `request.agent(app)` first, as `server/test/auth.test.ts` does.
- Prettier with single quotes. Don't reformat `ROADMAP.md` unless asked.
- Mongoose `bulkWrite` with `ordered: false` silently skips invalid documents; pass `throwOnValidationError: true`.
- Local MongoDB is pinned to `mongo:8.2` because the current `mongo:8` image refuses to start on Linux 6.19+.

## Rules From the Roadmap

- Every API route except sign-up, sign-in, and sign-out must require authentication. `app.ts` mounts `requireAuth` in front of everything after `/api/auth`, so new routers mounted below it are protected automatically; read the user from `req.user`. Every card, review log, and grading record carries a `userId`.
- Review logs are append-only (enforced by `ReviewLogModel` hooks) and carry client-generated UUID `_id`s, so sync is a union. They are written only through `POST /api/reviews`, which takes batches, skips IDs it already has (so clients can always re-send), and rejects IDs owned by another user with 409. Card (FSRS) state is derived from logs, never synced or stored as truth: replay them with `replayReviews`/`replayByCard` from `@hanyu/shared` (on the server, `loadCardSummaries` in `server/src/scheduling.ts`). Keep scheduling deterministic so client and server agree; change `SCHEDULER_PARAMS` deliberately, since it reschedules every card. Cards are keyed by `cardKey(noteType, noteId, kind)`.
- Word records store both simplified and traditional forms. Readings belong to words, not characters. Grade pinyin with `gradePinyin(answer, [citationPinyin, ...alternatePinyin], simplified)` (citation tones; 一/不 sandhi already undone). Its verdicts are `correct`, `tone`, and `wrong`; neutral-tone syllables accept any tone. `ratingForPinyin` turns a verdict into the FSRS rating (Good, Hard, Again); learners don't rate pinyin cards themselves. Answer fields use the client's `PinyinInput`, which converts tone numbers as you type.
- Seed data is generated: change the pipeline in `data/` and rebuild, never hand-edit `data/seed`. Keep each seed file under one license (see `data/seed/README.md`).
- Never commit `data/raw` (it holds the HSK syllabus PDF) and never parse the PDF's text; it has copying disabled.
- The client builds the queue from its own logs, so the server has no queue route: it stores and serves logs (`GET`/`POST /api/reviews`) and word content (`/api/dataset`, `/api/words`). Pulls page by the server's `createdAt` and clients re-read `PULL_OVERLAP_MS` each time, since concurrent writes can commit out of order.
- Handwriting cards (`character:<char>:handwriting`) become available once a word containing the character has been started, and are prompted with the first such word, blanked (学_). They draw on their own `dailyNewCards` allowance. `HandwritingQuiz` wraps hanzi-writer's quiz (always stroke-ordered); `ratingForHandwriting` grades the result (clean → Good, up to `allowedMisses` → Hard, more or any hint → Again), and `isStrokeOrderMistake` lets lenient mode forgive out-of-order strokes. Turning handwriting off suspends all handwriting cards.
- Stroke data (Make Me a Hanzi `graphics.txt`) is Arphic Public License and is sent to browsers, so its license text must stay reachable: the server serves `data/seed/LICENSES` at `/licenses`, and the handwriting card links to it.
- Leeches (`isLeech`): a card that has lapsed `LEECH_LAPSES` times, until it's answered Good/Easy `LEECH_CLEAR_STREAK` times in a row. Derived from logs like the schedule; never stored.
- Decks are HSK levels. New cards come from the user's enabled levels (`settings.levels`), most frequent first (`levelOrder`), after any added words (below), up to `settings.dailyNewCards` per study day; disabling a level never removes started cards from review. A study day starts at 4 a.m. in the time zone the client sends as `?tz=`. Only `ACTIVE_CARD_KINDS` (pinyin, for now) are queued.
- LLM calls go through the Express API only; keys live in env vars, never in the client bundle. The web app's only LLM call is translation grading (`POST /api/translations`, `gradeTranslation` in `shared/src/grading.ts`, Sonnet 5.5): limited to `GRADING_DAILY_LIMIT` per user per 24 hours and `GRADING_MONTHLY_BUDGET_USD` per month across users, and every grading (including failures) is logged in `translationgradings` before and after the call. Words the grader lists as mistranslated go into `settings.addedWords`.
- Changing `GRADER_MODEL` or `GRADER_PROMPT_VERSION` (bump it for any prompt or schema change) means running `npm run grader:eval`; `data/test/grader.test.ts` fails until results exist for the version. The MQM calibration data (`mqm-ted-zhen`, TED text under CC BY-NC-ND) stays in `data/raw`: never commit its text, only IDs and numbers.
- Never generate passages at request time. Content generation runs as offline scripts or one-off dynos.
- Keep persistent data in MongoDB, not on disk (Heroku's filesystem is ephemeral).
- Reading passages are generated only by `npm run passages:generate` (offline, `ANTHROPIC_API_KEY` in `.env`), stored as files in `data/passages`, and loaded by `npm run db:seed`, which refuses any under `MIN_LEVEL_SHARE` or without a passed answer-key check (`passages:check`). Spot-checks by hand go through `passages:review`. Don't hand-edit passage files to fix content; regenerate or delete them. Passage `tokens` (for tap-to-look-up) are derived; `passages:check` recomputes them.
- Listening exercises (`ListeningExercise` in `shared/src/listening.ts`): 1–3 sentences read aloud with the text hidden, then multiple-choice questions, replayable at will. Generated only by `npm run listening:generate` into `data/listening`, recorded by `audio:generate`, loaded by `db:seed` (same level and answer-key rules as passages). `GET /api/listening` lists summaries that never include the text; the client shows the transcript only once every question has been answered. Answers go to `POST /api/listening/:id/answers` and the same `questionanswers` log as reading (listening IDs start with `l`, passage IDs with `p`).
- "Add to SRS" stores word IDs in `settings.addedWords` (`POST`/`DELETE /api/settings/added-words`); `buildQueue` introduces unstarted added words first, from any level, within the daily new-card allowance. Recommendations (`recommendPassages`) score passages by how much of their vocabulary the learner's pinyin cards cover; which passages were read is kept per device in IndexedDB.
- Reading-question answers are logged in `questionanswers` (`POST /api/passages/:id/answers`, append-only, with `userId`): only whether each answer was right and how it was given, never the answer, so questions always start blank and can be answered again. Attempts and the best grade (`QuestionProgress`) are derived from the log and returned with passages.
- Read-aloud plays recorded clips (Azure neural TTS, `AUDIO_VOICE`) generated offline by `npm run audio:generate` into `data/audio` (committed, about 125 MB; kept out of the slug by `.slugignore`) and loaded by `npm run db:seed`; `GET /api/audio/:key` serves them (keys from `audioKeys` in `shared/src/audio.ts`). Never synthesize at request time. The client caches clips in Cache Storage (`client/src/local/audio.ts`) and falls back to the device voice (Web Speech API), except for homographs, which only recordings read (they force each reading's pinyin).
- Open decisions (the grading LLM, budget) are the user's call. Ask before choosing.

## Deployment

One Heroku dyno. `heroku-postbuild` runs `npm run build`; the `Procfile` runs `npm start`. With `NODE_ENV=production`, Express serves `client/dist` with an SPA fallback. `MONGODB_URI` points to MongoDB Atlas.
