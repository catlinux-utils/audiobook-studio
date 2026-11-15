import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadSettings, ensureDirs } from './config.js';
import { getDb, closeDb } from './db.js';
import { registerRoutes } from './api/routes.js';
import { queue } from './tts/queue.js';

ensureDirs();
getDb();

const settings = loadSettings();
const app = Fastify({
  logger: { level: 'info', transport: undefined },
  bodyLimit: 10 * 1024 * 1024,
});

await app.register(multipart);

// SPA static files in production (vite build output at dist/web)
const webDist = path.resolve('dist/web');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.type('text/html').send(fs.createReadStream(path.join(webDist, 'index.html')));
  });
}

registerRoutes(app);

const shutdown = async () => {
  await app.close();
  closeDb();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app
  .listen({ port: settings.port, host: '127.0.0.1' })
  .then((addr) => {
    console.log(`audiobook-studio listening on ${addr}`);
    console.log(`TTS backend: ${settings.audiocppUrl} (model: ${settings.model})`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
