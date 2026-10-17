import { replayReviews } from '@hanyu/shared';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewLogModel } from '../src/models/index.js';
import { loadCardSchedules } from '../src/scheduling.js';

// Integration tests: set MONGODB_TEST_URI (e.g. mongodb://localhost:27017) to run.
const uri = process.env.MONGODB_TEST_URI;

describe.skipIf(!uri)('loadCardSchedules', () => {
  const learner = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 9, 1, 9) + minutes * 60 * 1000);
  const logs = [
    {
      userId: learner,
      cardKey: 'word:hsk30-00001:pinyin',
      rating: 3,
      reviewedAt: at(10),
    },
    {
      userId: learner,
      cardKey: 'word:hsk30-00001:pinyin',
      rating: 3,
      reviewedAt: at(0),
    },
    {
      userId: learner,
      cardKey: 'word:hsk30-00002:meaning',
      rating: 1,
      reviewedAt: at(5),
    },
    {
      userId: other,
      cardKey: 'word:hsk30-00001:pinyin',
      rating: 1,
      reviewedAt: at(0),
    },
  ].map((log) => ({ _id: crypto.randomUUID(), ...log }));

  beforeAll(async () => {
    await mongoose.connect(uri!, {
      dbName: `hanyu-test-scheduling-${process.pid}`,
    });
    await ReviewLogModel.insertMany(logs);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it("replays only the user's own logs, per card", async () => {
    const schedules = await loadCardSchedules(learner);

    expect([...schedules.keys()].sort()).toEqual([
      'word:hsk30-00001:pinyin',
      'word:hsk30-00002:meaning',
    ]);
    const pinyin = schedules.get('word:hsk30-00001:pinyin')!;
    expect(pinyin).toEqual(
      replayReviews(logs.slice(0, 2).map((l) => ({ ...l, rating: 3 }))),
    );
    expect(pinyin.phase).toBe('review');
    expect(pinyin.reps).toBe(2);
  });

  it('limits the replay to the given card keys', async () => {
    const schedules = await loadCardSchedules(learner, [
      'word:hsk30-00002:meaning',
      'word:hsk30-09999:pinyin',
    ]);

    expect([...schedules.keys()]).toEqual(['word:hsk30-00002:meaning']);
  });
});
