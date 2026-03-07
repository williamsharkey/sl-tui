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
}

export function loadCredentials(): SavedCredentials | null {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf-8'));
    if (data.firstName && data.password) {
      return {
        firstName: data.firstName,
        lastName: data.lastName || 'Resident',
        password: data.password,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: SavedCredentials): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export function clearCredentials(): void {
  try {
    unlinkSync(FILE);
  } catch {}
}
