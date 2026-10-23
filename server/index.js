import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import dotenv from 'dotenv';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const app = createApp({ config: {
  email: process.env.JIRA_EMAIL?.trim(), token: process.env.JIRA_API_TOKEN?.trim(),
  cloudId: process.env.JIRA_CLOUD_ID?.trim(),
} });
const development = process.argv.includes('--dev');
if (development) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, 'dist'), { dotfiles: 'deny' }));
  app.get('/', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
}

const firstPort = Number(process.env.PORT || 4317);
if (!Number.isInteger(firstPort) || firstPort < 1024 || firstPort > 65525) throw new Error('PORT must be between 1024 and 65525.');
function listen(port) {
  const server = app.listen(port, '127.0.0.1', () => console.log(`Timesheet calendar: http://127.0.0.1:${port}`));
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && port < firstPort + 10) listen(port + 1);
    else {
      console.error(`Unable to start the local server (${error.code}).`);
      process.exitCode = 1;
    }
  });
}
listen(firstPort);