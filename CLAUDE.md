# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Hanyu is a MERN app for learning to read Chinese. [ROADMAP.md](ROADMAP.md) is the source of truth for goals, data-model decisions, and phase order. Read its "Foundational Decisions" section before touching schemas, scheduling, or sync. Check off roadmap items as they are completed.

## Layout

npm workspaces, all TypeScript and ESM:

- `shared/` (`@hanyu/shared`): types and logic used by every workspace: seed/document shapes (`content.ts`), pinyin helpers (`pinyin.ts`), typed-answer conversion and grading (`pinyinAnswer.ts`), FSRS scheduling (`scheduling.ts`, wrapping `ts-fsrs`), the review queue (`queue.ts`: study days, due order, new-card allowance), API types. Compiled to `shared/dist`, which client and server import. After changing it, rebuild (`npm run build -w shared`) or keep `npm run dev` running.
- `server/` (`@hanyu/server`): Express 5 + Mongoose. `src/app.ts` builds the app (`createApp()`, no side effects, used by tests); `src/index.ts` connects to MongoDB and listens. Routes live in `src/routes/` and mount under `/api`. Authentication is in `src/auth/` (scrypt passwords, cookie sessions stored hashed in the `sessions` collection, `requireAuth` middleware).
- `client/` (`@hanyu/client`): React 19 + Vite. Calls the API through relative `/api/...` paths (Vite proxies to :5000 in dev; same origin in production). Local-first: `src/local/` keeps each user's review logs and cached word content in IndexedDB (`store.ts`), syncs logs both ways (`sync.ts`), and builds the queue and decks on the device with `buildQueue`/`buildDecks` from `@hanyu/shared`. Tests use `fake-indexeddb`.
- `data/` (`@hanyu/data`): offline pipeline (run with tsx, never deployed as code) that builds `data/seed` from pinned sources in `data/raw`. Read `data/README.md` before changing it.

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
- Leeches (`isLeech`): a card that has lapsed `LEECH_LAPSES` times, until it's answered Good/Easy `LEECH_CLEAR_STREAK` times in a row. Derived from logs like the schedule; never stored.
- Decks are HSK levels. New cards come only from the user's enabled levels (`settings.levels`), most frequent first (`levelOrder`), up to `settings.dailyNewCards` per study day; disabling a level never removes started cards from review. A study day starts at 4 a.m. in the time zone the client sends as `?tz=`. Only `ACTIVE_CARD_KINDS` (pinyin, for now) are queued.
- LLM calls go through the Express API only; keys live in env vars, never in the client bundle.
- Never generate passages at request time. Content generation runs as offline scripts or one-off dynos.
- Keep persistent data in MongoDB, not on disk (Heroku's filesystem is ephemeral).
- Open decisions (LLM provider, budget) are the user's call. Ask before choosing.

## Deployment

One Heroku dyno. `heroku-postbuild` runs `npm run build`; the `Procfile` runs `npm start`. With `NODE_ENV=production`, Express serves `client/dist` with an SPA fallback. `MONGODB_URI` points to MongoDB Atlas.
