// input.ts — Raw stdin keypress handler with mode-based dispatch

import * as readline from 'readline';
import type { ISLBridge } from './types.js';

export type Mode = 'login' | 'grid' | 'chat-input';

export interface InputCallbacks {
  onMove: (dir: string) => void;
  onStop: () => void;
  onToggleFly: () => void;
  onToggleDither: () => void;
  onTurnLeft: () => void;
  onTurnRight: () => void;
  onEnterChat: () => void;
  onExitChat: () => void;
  onChatSubmit: (text: string) => void;
  onChatChar: (char: string) => void;
  onChatBackspace: () => void;
  onQuit: () => void;
  onLoginChar: (char: string) => void;
  onLoginBackspace: () => void;
  onLoginSubmit: () => void;
  onLoginTab: () => void;
}

export class InputHandler {
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: Mode = 'grid';
  private callbacks: InputCallbacks;
  private stdinListening = false;

  constructor(callbacks: InputCallbacks) {
    this.callbacks = callbacks;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  start(stdin: NodeJS.ReadStream): void {
    if (this.stdinListening) return;
    this.stdinListening = true;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    readline.emitKeypressEvents(stdin);

    stdin.on('keypress', (_str: string | undefined, key: readline.Key) => {
      this.handleKey(_str, key);
    });
  }

  stop(stdin: NodeJS.ReadStream): void {
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdin.removeAllListeners('keypress');
    this.stdinListening = false;
  }

  handleKey(str: string | undefined, key: readline.Key): void {
    // Ctrl+C always quits
    if (key.ctrl && key.name === 'c') {
      this.callbacks.onQuit();
      return;
    }

    if (this.mode === 'login') {
      this.handleLoginKey(str, key);
    } else if (this.mode === 'grid') {
      this.handleGridKey(str, key);
    } else if (this.mode === 'chat-input') {
      this.handleChatKey(str, key);
    }
  }

  private handleLoginKey(str: string | undefined, key: readline.Key): void {
    if (key.name === 'return') {
      this.callbacks.onLoginSubmit();
    } else if (key.name === 'tab') {
      this.callbacks.onLoginTab();
    } else if (key.name === 'backspace') {
      this.callbacks.onLoginBackspace();
    } else if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
      this.callbacks.onLoginChar(str);
    }
  }

  private handleGridKey(str: string | undefined, key: readline.Key): void {
    // Body-relative: up=forward, down=back, left=turn left, right=turn right
    // a/d = strafe left/right, space = jump
    if (key.name === 'up') {
      this.callbacks.onMove('forward');
      this.scheduleStop();
      return;
    }
    if (key.name === 'down') {
      this.callbacks.onMove('back');
      this.scheduleStop();
      return;
    }
    if (key.name === 'left') {
      this.callbacks.onTurnLeft();
      return;
    }
    if (key.name === 'right') {
      this.callbacks.onTurnRight();
      return;
    }

    if (str === 'w' || str === 'W') {
      this.callbacks.onMove('forward');
      this.scheduleStop();
    } else if (str === 's' || str === 'S') {
      this.callbacks.onMove('back');
      this.scheduleStop();
    } else if (str === 'a' || str === 'A') {
      this.callbacks.onMove('strafe_left');
      this.scheduleStop();
    } else if (str === 'd' || str === 'D') {
      this.callbacks.onMove('strafe_right');
      this.scheduleStop();
    } else if (str === ' ') {
      this.callbacks.onMove('up');
      this.scheduleStop();
    } else if (str === 'f' || str === 'F') {
      this.callbacks.onToggleFly();
    } else if (str === 'v' || str === 'V') {
      this.callbacks.onToggleDither();
    } else if (key.name === 'return') {
      this.callbacks.onEnterChat();
    } else if (str === 'q' || str === 'Q') {
      this.callbacks.onQuit();
    }
  }

  private handleChatKey(str: string | undefined, key: readline.Key): void {
    if (key.name === 'escape') {
      this.callbacks.onExitChat();
    } else if (key.name === 'return') {
      this.callbacks.onChatSubmit('');
    } else if (key.name === 'backspace') {
      this.callbacks.onChatBackspace();
    } else if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
      this.callbacks.onChatChar(str);
    }
  }

  private scheduleStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.callbacks.onStop();
      this.stopTimer = null;
    }, 200);
  }
}
