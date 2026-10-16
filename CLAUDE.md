# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

Hanyu is a MERN app for learning to read Chinese. [ROADMAP.md](ROADMAP.md) is the source of truth for goals, data-model decisions, and phase order. Read its "Foundational Decisions" section before touching schemas, scheduling, or sync. Check off roadmap items as they are completed.

## Layout

npm workspaces, all TypeScript and ESM:

- `shared/` (`@hanyu/shared`): types and logic used by both sides. Compiled to `shared/dist`, which client and server import. After changing it, rebuild (`npm run build -w shared`) or keep `npm run dev` running.
- `server/` (`@hanyu/server`): Express 5 + Mongoose. `src/app.ts` builds the app (`createApp()`, no side effects, used by tests); `src/index.ts` connects to MongoDB and listens. Routes live in `src/routes/` and mount under `/api`.
- `client/` (`@hanyu/client`): React 19 + Vite. Calls the API through relative `/api/...` paths (Vite proxies to :5000 in dev; same origin in production).

## Commands

```sh
npm run dev         # everything in watch mode (needs MongoDB: npm run db:up)
npm test            # vitest + supertest (server/test)
npm run typecheck   # tsc across workspaces
npm run build       # shared → server → client
npm run format      # prettier
```

Before finishing a change, run `npm run typecheck` and `npm test`.

## Conventions

- Server imports use NodeNext resolution: relative imports need a `.js` extension (`./db.js`). The client uses bundler resolution without extensions.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Put request/response types in `shared/` so client and server agree.
- API errors are JSON: `{ "error": "message" }`.
- Express 5 catch-all routes use `'/{*splat}'`, and async handlers can throw (errors reach the error handler).
- Add a supertest test in `server/test/` for each new route, using `createApp()` (no database needed unless the route uses one).
- Prettier with single quotes. Don't reformat `ROADMAP.md` unless asked.

## Rules From the Roadmap

- Every API route except sign-in/sign-up must require authentication. Every card, review log, and grading record carries a `userId`.
- Review logs are append-only. Card (FSRS) state is derived from logs, never synced directly.
- Word records store both simplified and traditional forms. Readings belong to words, not characters.
- LLM calls go through the Express API only; keys live in env vars, never in the client bundle.
- Never generate passages at request time. Content generation runs as offline scripts or one-off dynos.
- Keep persistent data in MongoDB, not on disk (Heroku's filesystem is ephemeral).
- Open decisions (auth method, LLM provider, budget) are the user's call. Ask before choosing.

## Deployment

One Heroku dyno. `heroku-postbuild` runs `npm run build`; the `Procfile` runs `npm start`. With `NODE_ENV=production`, Express serves `client/dist` with an SPA fallback. `MONGODB_URI` points to MongoDB Atlas.
