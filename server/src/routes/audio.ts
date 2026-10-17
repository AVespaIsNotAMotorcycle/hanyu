import { AUDIO_MIME } from '@hanyu/shared';
import { Router } from 'express';
import { AudioClipModel } from '../models/index.js';

// Recorded clips (generated offline; see data/README.md). 404 means there's
// no recording, and the client reads the text with the device's voice.
export const audioRouter = Router();

audioRouter.get('/:key', async (req, res) => {
  const clip = await AudioClipModel.findById(req.params.key, {
    hash: 1,
    data: 1,
  }).lean();
  if (!clip) {
    res.status(404).json({ error: 'No recording' });
    return;
  }
  // The client keeps clips for offline use and revalidates them with
  // If-None-Match; Express answers 304 when the ETag still matches.
  res.set({
    'Content-Type': AUDIO_MIME,
    ETag: `"${clip.hash}"`,
    'Cache-Control': 'private, no-cache',
  });
  res.send(Buffer.from(clip.data.buffer ?? clip.data));
});
