# 汉语 Hanyu

A personal app for learning to read Chinese, starting with modern Mandarin in simplified characters and working toward traditional characters and Classical Chinese. It combines spaced-repetition flashcards (handwriting and pinyin), graded reading passages, and LLM-graded translation challenges.

See [ROADMAP.md](ROADMAP.md) for goals, design decisions, and the phase plan.

## Stack

- **MongoDB** (Atlas in production) via Mongoose
- **Express 5** REST API in TypeScript
- **React 19** + TypeScript, built with Vite
- **Node.js 24**
- Deployed as one Heroku dyno, where Express serves both the API and the React build

## Repository Layout

npm workspaces monorepo:

```
client/   React app (Vite). Dev server on :5173, proxies /api to :5000
server/   Express API. Serves client/dist in production
shared/   TypeScript shared by all workspaces (content types, pinyin helpers)
data/     Pipeline that builds the seed dataset in data/seed (see data/README.md)
```

## Getting Started

Prerequisites: Node.js 24 and Docker (for a local MongoDB), or a MongoDB Atlas connection string.

```sh
npm install
cp .env.example .env   # adjust MONGODB_URI if needed
npm run db:up          # start MongoDB in Docker on :27017
npm run db:seed        # load HSK words, characters, and grammar into MongoDB
npm run dev            # shared (watch) + server (:5000) + client (:5173)
```

The seed dataset in `data/seed` is committed, so seeding needs no downloads. To rebuild it from the original sources, see [data/README.md](data/README.md).

Open http://localhost:5173. The page shows whether the API and database are reachable.

## Scripts

Run from the repository root:

| Script                 | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `npm run dev`          | Run shared, server, and client in watch mode                           |
| `npm run build`        | Build shared, then server, then client                                 |
| `npm start`            | Run the built server (set `NODE_ENV=production` to serve UI)           |
| `npm test`             | Run all workspace tests                                                |
| `npm run typecheck`    | Type-check all workspaces                                              |
| `npm run format`       | Format with Prettier                                                   |
| `npm run db:up`/`down` | Start or stop the local MongoDB container                              |
| `npm run db:seed`      | Load `data/seed` into MongoDB (idempotent; `-- --force`, `-- --prune`) |
| `npm run data:fetch`   | Download pipeline sources into `data/raw` and verify their hashes      |
| `npm run data:build`   | Rebuild `data/seed` from `data/raw`                                    |

## Configuration

Environment variables, read from `.env` locally (see `.env.example`) or Heroku config vars in production:

| Variable           | Default                           | Purpose                                                                       |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| `NODE_ENV`         | `development`                     | `production` makes Express serve the client                                   |
| `PORT`             | `5000`                            | API port (Heroku sets this)                                                   |
| `MONGODB_URI`      | `mongodb://localhost:27017/hanyu` | MongoDB connection string                                                     |
| `MONGODB_TEST_URI` | (unset)                           | MongoDB server for the database integration tests; they're skipped when unset |

## Deploying to Heroku

```sh
heroku create
heroku config:set NODE_ENV=production MONGODB_URI="<atlas connection string>"
git push heroku main
```

Heroku runs `heroku-postbuild` (`npm run build`) and then the `Procfile` (`web: npm start`). Load the dataset into Atlas once per dataset version with `heroku run npm run seed -w server`. Heroku has no first-party MongoDB add-on, so use MongoDB Atlas. Keep all persistent data in MongoDB, since the dyno filesystem is ephemeral.

## Licensing of Data Sources

The seed dataset combines the HSK 3.0 syllabus lists, CC-CEDICT (CC BY-SA 4.0), wordfreq (CC BY-SA 4.0, including SUBTLEX-CH), and Make Me a Hanzi (LGPL-3.0-or-later and Arphic Public License). See [data/seed/README.md](data/seed/README.md) for attribution, and the Licensing section of [ROADMAP.md](ROADMAP.md) for obligations.
