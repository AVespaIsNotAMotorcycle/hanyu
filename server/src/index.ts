import { createApp } from './app.js';
import { config } from './config.js';
import { connectDb } from './db.js';

await connectDb(config.mongodbUri);

const app = createApp({ serveClient: config.isProduction });

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});
