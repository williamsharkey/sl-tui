// login-screen.ts — ASCII login form

import type { WritableTarget } from './types.js';
import { moveTo } from './renderer.js';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;

export type LoginField = 'firstName' | 'lastName' | 'password';

export interface LoginState {
  firstName: string;
  lastName: string;
  password: string;
  activeField: LoginField;
  error: string;
}

export function createLoginState(): LoginState {
  return {
    firstName: '',
    lastName: '',
    password: '',
    activeField: 'firstName',
    error: '',
  };
}

export function renderLoginScreen(out: WritableTarget, state: LoginState): void {
  const w = out.columns;
  const h = out.rows;
  const boxW = 44;
  const boxH = 14;
  const startCol = Math.max(0, Math.floor((w - boxW) / 2));
  const startRow = Math.max(0, Math.floor((h - boxH) / 2));

  let buf = `${ESC}2J`; // clear

  // Title
  buf += moveTo(startRow, startCol) + BOLD + '  SL-TUI: Second Life Terminal Client' + RESET;
  buf += moveTo(startRow + 1, startCol) + DIM + '  \u2500'.repeat(boxW - 4) + RESET;

  // Fields
  const fields: { label: string; key: LoginField; mask: boolean }[] = [
    { label: 'First Name', key: 'firstName', mask: false },
    { label: 'Last Name ', key: 'lastName', mask: false },
    { label: 'Password  ', key: 'password', mask: true },
  ];

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const row = startRow + 3 + i * 2;
    const isActive = state.activeField === f.key;
    const value = f.mask ? '*'.repeat(state[f.key].length) : state[f.key];
    const cursor = isActive ? '\u2588' : '';

    buf += moveTo(row, startCol + 2);
    buf += (isActive ? BOLD : DIM) + f.label + ': ' + RESET;
    buf += (isActive ? REVERSE : '') + ' ' + value + cursor + ' '.repeat(Math.max(0, 20 - value.length)) + RESET;
  }

  // Error
  if (state.error) {
    buf += moveTo(startRow + 10, startCol + 2) + `${ESC}31m` + state.error + RESET;
  }

  // Hints
  buf += moveTo(startRow + 12, startCol + 2) + DIM + 'Tab: next field  Enter: login  Ctrl+C: quit' + RESET;

  out.write(buf);
}

export function nextField(state: LoginState): void {
  const order: LoginField[] = ['firstName', 'lastName', 'password'];
  const idx = order.indexOf(state.activeField);
  state.activeField = order[(idx + 1) % order.length];
}

export function loginFieldAppend(state: LoginState, char: string): void {
  state[state.activeField] += char;
}

export function loginFieldBackspace(state: LoginState): void {
  const field = state.activeField;
  state[field] = state[field].slice(0, -1);
}
