#!/usr/bin/env node
// main.ts — CLI entry point for TUI client

import { SLBridge } from '../server/sl-bridge.js';
import { TUIApp } from './app.js';
import { computeLayout } from './screen.js';
import { setBwMode, setTruecolor } from './renderer.js';
import { loadCredentials, saveCredentials, clearCredentials } from './credentials.js';
import type { WritableTarget } from './types.js';

// Parse CLI args
const args = process.argv.slice(2);
let firstName = '';
let lastName = 'Resident';
let password = '';

let bw = false;
let use256 = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bw') {
    bw = true;
  } else if (args[i] === '--256') {
    use256 = true;
  } else if ((args[i] === '--username' || args[i] === '-u') && args[i + 1]) {
    const name = args[++i];
    if (name.includes(' ')) {
      const parts = name.split(' ');
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    } else {
      firstName = name;
    }
  } else if ((args[i] === '--password' || args[i] === '-p') && args[i + 1]) {
    password = args[++i];
  } else if ((args[i] === '--last' || args[i] === '-l') && args[i + 1]) {
    lastName = args[++i];
  }
}

// Also check env vars
if (!firstName && process.env.SL_USERNAME) {
  const name = process.env.SL_USERNAME;
  if (name.includes(' ')) {
    const parts = name.split(' ');
    firstName = parts[0];
    lastName = parts.slice(1).join(' ');
  } else {
    firstName = name;
  }
}
if (!password && process.env.SL_PASSWORD) {
  password = process.env.SL_PASSWORD;
}

// Check saved credentials if nothing provided via CLI/env
if (!firstName && !password) {
  const saved = loadCredentials();
  if (saved) {
    firstName = saved.firstName;
    lastName = saved.lastName;
    password = saved.password;
  }
}

if (bw) setBwMode(true);
if (use256) setTruecolor(false);

// Create stdout WritableTarget
const stdoutTarget: WritableTarget = {
  write(data: string) {
    process.stdout.write(data);
  },
  get columns() {
    return process.stdout.columns || 80;
  },
  get rows() {
    return process.stdout.rows || 24;
  },
};

const autoLogin = firstName && password
  ? { firstName, lastName, password }
  : undefined;

const app = new TUIApp({
  bridge: new SLBridge(),
  output: stdoutTarget,
  stdin: process.stdin,
  autoLogin,
  createBridge: () => new SLBridge(),
  onLoginSuccess: (fn, ln, pw) => {
    saveCredentials({ firstName: fn, lastName: ln, password: pw });
  },
  onLogout: () => {
    clearCredentials();
  },
});

// Handle resize
process.stdout.on('resize', () => {
  app.handleResize(process.stdout.columns, process.stdout.rows);
});

app.start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
