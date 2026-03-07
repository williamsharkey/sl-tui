// credentials.ts — Save/load login credentials to ~/.sl-tui/credentials.json

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.sl-tui');
const FILE = join(DIR, 'credentials.json');

export interface SavedCredentials {
  firstName: string;
  lastName: string;
  password: string;
  savedAt?: number; // epoch ms
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function loadCredentials(): SavedCredentials | null {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf-8'));
    if (data.firstName && data.password) {
      // Check staleness
      if (data.savedAt && Date.now() - data.savedAt > MAX_AGE_MS) {
        return null;
      }
      return {
        firstName: data.firstName,
        lastName: data.lastName || 'Resident',
        password: data.password,
        savedAt: data.savedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: SavedCredentials): void {
  mkdirSync(DIR, { recursive: true });
  const data = { ...creds, savedAt: Date.now() };
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function clearCredentials(): void {
  try {
    unlinkSync(FILE);
  } catch {}
}
