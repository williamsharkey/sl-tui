// main.ts — Express static + ws upgrade, session lifecycle

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from './session.js';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const sessions = new Map<string, Session>();

wss.on('connection', (ws: WebSocket) => {
  const sessionId = crypto.randomUUID();
  const session = new Session(sessionId, ws);
  sessions.set(sessionId, session);
  console.log(`[${sessionId.slice(0, 8)}] connected (${sessions.size} active)`);

  ws.on('message', async (data: Buffer) => {
    try {
      await session.handleMessage(data.toString());
    } catch (err) {
      console.error(`[${sessionId.slice(0, 8)}] error:`, err);
    }
  });

  ws.on('close', async () => {
    console.log(`[${sessionId.slice(0, 8)}] disconnected`);
    sessions.delete(sessionId);
    try {
      await session.close();
    } catch {
      // ignore
    }
  });

  ws.on('error', (err) => {
    console.error(`[${sessionId.slice(0, 8)}] ws error:`, err);
  });
});

server.listen(PORT, () => {
  console.log(`SL-TUI server listening on http://localhost:${PORT}`);
});
