#!/usr/bin/env tsx
// bridge.ts — Node.js subprocess that proxies SL protocol via node-metaverse
// Communicates with parent C process via newline-delimited JSON on stdin/stdout.

import * as readline from 'readline';
import { SLBridge } from '../server/sl-bridge.js';
import type { BridgeCallbacks } from '../server/sl-bridge.js';

const bridge = new SLBridge();
let stateInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Send heartbeat every 2 seconds so C side knows we're alive
heartbeatInterval = setInterval(() => {
  send({ ev: 'heartbeat' });
}, 2000);

// Send event to parent (C process reads from our stdout)
function send(obj: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Read commands from parent (C process writes to our stdin)
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line: string) => {
  let cmd: any;
  try {
    cmd = JSON.parse(line);
  } catch {
    return; // ignore malformed JSON
  }

  try {
    await handleCommand(cmd);
  } catch (err: any) {
    // Log errors to stderr (not stdout — that's the IPC channel)
    process.stderr.write(`Bridge error: ${err.message}\n`);
  }
});

async function handleCommand(cmd: any) {
  switch (cmd.cmd) {
    case 'login': {
      const callbacks: BridgeCallbacks = {
        onChat: (from, message, chatType, fromId) => {
          send({ ev: 'chat', from, msg: message, chatType, fromId });
        },
        onIM: (from, fromName, message, isGroup, groupName) => {
          send({ ev: 'im', from, fromName, msg: message, isGroup, groupName });
        },
        onFriendRequest: (from, fromName, message, requestId) => {
          send({ ev: 'friend_req', from, fromName, msg: message, requestId });
        },
        onFriendOnline: (name, uuid, online) => {
          send({ ev: 'friend_online', name, uuid, online });
        },
        onTeleportOffer: (from, fromName, message) => {
          send({ ev: 'tp_offer', from, fromName, msg: message });
        },
        onDisconnected: (reason) => {
          send({ ev: 'disconnected', reason });
        },
      };

      try {
        const result = await bridge.login(cmd.firstName, cmd.lastName, cmd.password, callbacks);
        send({ ev: 'login_ok', region: result.region, waterHeight: result.waterHeight });

        // Send terrain data
        sendTerrain();

        // Start state update loop at 4Hz
        if (stateInterval) clearInterval(stateInterval);
        stateInterval = setInterval(() => sendState(), 250);
      } catch (err: any) {
        send({ ev: 'login_fail', error: err.message || String(err) });
      }
      break;
    }

    case 'move':
      bridge.move(cmd.dir);
      break;

    case 'stop':
      bridge.stop();
      break;

    case 'turn':
      bridge.turn(cmd.dir);
      break;

    case 'fly':
      bridge.setFlying(cmd.enable);
      break;

    case 'say':
      await bridge.say(cmd.msg, cmd.channel);
      break;

    case 'whisper':
      await bridge.whisper(cmd.msg);
      break;

    case 'shout':
      await bridge.shout(cmd.msg);
      break;

    case 'im':
      await bridge.sendIM(cmd.to, cmd.msg);
      break;

    case 'teleport':
      try {
        await bridge.teleportToRegion(cmd.region, cmd.x, cmd.y, cmd.z);
        const region = bridge.getRegionName();
        send({ ev: 'login_ok', region, waterHeight: bridge.getWaterHeight() });
        sendTerrain();
      } catch (err: any) {
        send({ ev: 'chat', from: '*System', msg: `Teleport failed: ${err.message}` });
      }
      break;

    case 'logout':
      if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
      await bridge.close();
      break;

    case 'quit':
      if (stateInterval) { clearInterval(stateInterval); stateInterval = null; }
      try { await bridge.close(); } catch {}
      process.exit(0);
      break;
  }
}

function sendState() {
  const pos = bridge.getPosition();
  if (!pos) return;

  const yaw = bridge.getBodyYaw();
  const region = bridge.getRegionName();

  // Region crossing check
  bridge.checkRegionCrossing();
  bridge.tickFlyTo();

  const avatars = bridge.getAvatars().map(av => ({
    uuid: av.uuid,
    firstName: av.firstName,
    lastName: av.lastName,
    pos: [av.x, av.y, av.z],
    yaw: av.yaw,
    isSelf: av.isSelf,
  }));

  const objects = bridge.getObjects().map(obj => ({
    uuid: obj.uuid,
    pos: [obj.x, obj.y, obj.z],
    scale: [obj.scaleX, obj.scaleY, obj.scaleZ],
    isTree: obj.isTree,
  }));

  send({
    ev: 'state',
    pos: [pos.x, pos.y, pos.z],
    yaw,
    flying: bridge.flying,
    region,
    avatars,
    objects,
  });
}

function sendTerrain() {
  // Send all 256x256 terrain heights
  const heights: number[] = new Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      heights[y * 256 + x] = bridge.getTerrainHeight(x, y);
    }
  }
  send({ ev: 'terrain', heights });
}

// Handle stdin close (parent died)
rl.on('close', async () => {
  if (stateInterval) clearInterval(stateInterval);
  try { await bridge.close(); } catch {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (stateInterval) clearInterval(stateInterval);
  try { await bridge.close(); } catch {}
  process.exit(0);
});
