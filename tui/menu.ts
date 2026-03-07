// menu.ts — Lotus 1-2-3 style hierarchical command menu
// Press / in grid mode to open. Letter keys select categories.
// Esc goes back up the tree or closes the menu.

import type { ScreenLayout } from './screen.js';
import { moveTo, fgColor, bgColor, isBwMode } from './renderer.js';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;

// Panel colors
const PBG = '#1a1a2e';
const PFG = '#cccccc';
const BORDER_FG = '#555555';
const KEY_FG = '#ffcc00';
const ONLINE_FG = '#44cc44';
const DIM_FG = '#666666';

export interface IMMessage {
  peerUuid: string;
  peerName: string;
  message: string;
  ts: number;
  outgoing: boolean;
}

export interface MenuActions {
  sendIM: (toUuid: string, message: string) => Promise<void>;
  flyToAvatar: (uuid: string) => void;
  getProfile: (uuid: string) => Promise<{ displayName: string; userName: string; bio: string; bornOn: string } | null>;
  getFriendsList: () => Promise<{ uuid: string; name: string; online: boolean }[]>;
  teleportHome: () => Promise<void>;
  teleportRegion: (region: string, x?: number, y?: number, z?: number) => Promise<void>;
  stand: () => void;
  closeMenu: () => void;
  systemMessage: (msg: string) => void;
}

interface MenuFrame {
  kind: string;
  uuid?: string;
  name?: string;
}

interface PanelLine {
  text: string;
  selected?: boolean;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function firstName(full: string): string {
  return full.split(' ')[0] || full;
}

export class MenuPanel {
  private stack: MenuFrame[] = [];
  private friends: { uuid: string; name: string; online: boolean }[] = [];
  private friendsLoading = false;
  private selectedIdx = 0;
  private scrollOffset = 0;
  private inputBuf = '';
  private profileLines: string[] = [];
  private profileLoading = false;
  readonly imMessages: IMMessage[] = [];
  private lastReadTs = 0;
  private actions: MenuActions;

  constructor(actions: MenuActions) {
    this.actions = actions;
  }

  get isOpen(): boolean { return this.stack.length > 0; }

  get isInputMode(): boolean {
    if (!this.isOpen) return false;
    const k = this.current.kind;
    return k === 'compose' || k === 'tp-input';
  }

  private get current(): MenuFrame {
    return this.stack[this.stack.length - 1];
  }

  open(): void {
    this.stack = [{ kind: 'root' }];
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.inputBuf = '';
  }

  close(): void {
    this.stack = [];
    this.prevPanelRows = 0;
  }

  addIM(peerUuid: string, peerName: string, message: string, outgoing: boolean): void {
    this.imMessages.push({ peerUuid, peerName, message, ts: Date.now(), outgoing });
  }

  get unreadCount(): number {
    return this.imMessages.filter(m => !m.outgoing && m.ts > this.lastReadTs).length;
  }

  private push(frame: MenuFrame): void {
    this.stack.push(frame);
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.inputBuf = '';
  }

  private pop(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.selectedIdx = 0;
    this.scrollOffset = 0;
    this.inputBuf = '';
    return true;
  }

  // --- IM conversation grouping ---

  private getConversations(): { uuid: string; name: string; lastMsg: string; lastTs: number; count: number; unread: number }[] {
    const map = new Map<string, { uuid: string; name: string; msgs: IMMessage[] }>();
    for (const m of this.imMessages) {
      let c = map.get(m.peerUuid);
      if (!c) {
        c = { uuid: m.peerUuid, name: m.peerName, msgs: [] };
        map.set(m.peerUuid, c);
      }
      c.msgs.push(m);
      if (m.peerName) c.name = m.peerName;
    }
    return Array.from(map.values())
      .map(c => {
        const last = c.msgs[c.msgs.length - 1];
        const unread = c.msgs.filter(m => !m.outgoing && m.ts > this.lastReadTs).length;
        return { uuid: c.uuid, name: c.name, lastMsg: last.message, lastTs: last.ts, count: c.msgs.length, unread };
      })
      .sort((a, b) => b.lastTs - a.lastTs);
  }

  private getConversationMessages(uuid: string): IMMessage[] {
    return this.imMessages.filter(m => m.peerUuid === uuid);
  }

  // --- Async data loading ---

  private async loadFriends(): Promise<void> {
    if (this.friendsLoading) return;
    this.friendsLoading = true;
    try {
      const list = await this.actions.getFriendsList();
      this.friends = list.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      this.friends = [];
    } finally {
      this.friendsLoading = false;
    }
  }

  private async loadProfile(uuid: string): Promise<void> {
    this.profileLoading = true;
    this.profileLines = ['Loading...'];
    try {
      const p = await this.actions.getProfile(uuid);
      if (p) {
        this.profileLines = [
          `Name: ${p.displayName}`,
          `User: ${p.userName}`,
          `Born: ${p.bornOn}`,
          '',
          ...p.bio.split('\n').slice(0, 8),
        ];
      } else {
        this.profileLines = ['Profile not available'];
      }
    } catch {
      this.profileLines = ['Failed to load profile'];
    } finally {
      this.profileLoading = false;
    }
  }

  // --- Scroll helpers ---

  private ensureVisible(listLen: number, maxVisible: number): void {
    if (listLen <= maxVisible) { this.scrollOffset = 0; return; }
    if (this.selectedIdx < this.scrollOffset) this.scrollOffset = this.selectedIdx;
    if (this.selectedIdx >= this.scrollOffset + maxVisible) this.scrollOffset = this.selectedIdx - maxVisible + 1;
  }

  // Returns index if an item was selected, null otherwise
  private handleListNav(str: string | undefined, key: { name?: string }, listLen: number): number | null {
    if (key.name === 'up' || str === 'k' || str === 'K') {
      if (this.selectedIdx > 0) this.selectedIdx--;
      return null;
    }
    if (key.name === 'down' || str === 'j' || str === 'J') {
      if (this.selectedIdx < listLen - 1) this.selectedIdx++;
      return null;
    }
    if (key.name === 'return' && listLen > 0) {
      return this.selectedIdx;
    }
    // Number keys 1-9: select visible item
    if (str && str >= '1' && str <= '9') {
      const visIdx = parseInt(str) - 1;
      const absIdx = this.scrollOffset + visIdx;
      if (absIdx < listLen) {
        this.selectedIdx = absIdx;
        return absIdx;
      }
    }
    return null;
  }

  // --- Key handling: returns true to stay open, false to close ---

  handleKey(str: string | undefined, key: { name?: string; ctrl?: boolean }): boolean {
    if (!this.isOpen) return false;

    // Esc always goes back
    if (key.name === 'escape') {
      if (!this.pop()) { this.close(); return false; }
      return true;
    }

    switch (this.current.kind) {
      case 'root':        return this.handleRootKey(str);
      case 'friends':     return this.handleFriendsKey(str, key);
      case 'friend-act':  return this.handleFriendActKey(str);
      case 'messages':    return this.handleMessagesKey(str, key);
      case 'conversation': return this.handleConversationKey(str, key);
      case 'compose':     return this.handleComposeKey(str, key);
      case 'teleport':    return this.handleTeleportKey(str);
      case 'tp-input':    return this.handleTpInputKey(str, key);
      case 'actions':     return this.handleActionsKey(str);
      case 'profile':     this.pop(); return true;
    }
    return true;
  }

  private handleRootKey(str: string | undefined): boolean {
    const ch = str?.toLowerCase();
    if (ch === 'f') { this.push({ kind: 'friends' }); this.loadFriends(); }
    else if (ch === 'm') { this.push({ kind: 'messages' }); this.lastReadTs = Date.now(); }
    else if (ch === 't') { this.push({ kind: 'teleport' }); }
    else if (ch === 'a') { this.push({ kind: 'actions' }); }
    return true;
  }

  private handleFriendsKey(str: string | undefined, key: { name?: string }): boolean {
    const sel = this.handleListNav(str, key, this.friends.length);
    if (sel !== null) {
      const f = this.friends[sel];
      this.push({ kind: 'friend-act', uuid: f.uuid, name: f.name });
    }
    return true;
  }

  private handleFriendActKey(str: string | undefined): boolean {
    const ch = str?.toLowerCase();
    if (ch === 'm') {
      this.push({ kind: 'compose', uuid: this.current.uuid, name: this.current.name });
    } else if (ch === 'g') {
      this.actions.flyToAvatar(this.current.uuid!);
      this.actions.systemMessage(`Flying to ${this.current.name}`);
      this.close(); return false;
    } else if (ch === 'p') {
      this.push({ kind: 'profile', uuid: this.current.uuid, name: this.current.name });
      this.loadProfile(this.current.uuid!);
    }
    return true;
  }

  private handleMessagesKey(str: string | undefined, key: { name?: string }): boolean {
    const convs = this.getConversations();
    const sel = this.handleListNav(str, key, convs.length);
    if (sel !== null) {
      const c = convs[sel];
      this.push({ kind: 'conversation', uuid: c.uuid, name: c.name });
    }
    return true;
  }

  private handleConversationKey(str: string | undefined, key: { name?: string }): boolean {
    const ch = str?.toLowerCase();
    if (ch === 'r') {
      this.push({ kind: 'compose', uuid: this.current.uuid, name: this.current.name });
    } else if (ch === 'p') {
      this.push({ kind: 'profile', uuid: this.current.uuid, name: this.current.name });
      this.loadProfile(this.current.uuid!);
    } else {
      // scroll with up/down
      if (key.name === 'up' || str === 'k') { if (this.scrollOffset > 0) this.scrollOffset--; }
      else if (key.name === 'down' || str === 'j') { this.scrollOffset++; }
    }
    return true;
  }

  private handleComposeKey(str: string | undefined, key: { name?: string }): boolean {
    if (key.name === 'return') {
      if (this.inputBuf.trim()) {
        const uuid = this.current.uuid!;
        const name = this.current.name!;
        const msg = this.inputBuf.trim();
        this.addIM(uuid, name, msg, true);
        this.actions.sendIM(uuid, msg);
        this.actions.systemMessage(`IM to ${name}: ${msg}`);
      }
      this.pop();
      return true;
    }
    if (key.name === 'backspace') {
      this.inputBuf = this.inputBuf.slice(0, -1);
      return true;
    }
    if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
      this.inputBuf += str;
    }
    return true;
  }

  private handleTeleportKey(str: string | undefined): boolean {
    const ch = str?.toLowerCase();
    if (ch === 'h') {
      this.actions.teleportHome();
      this.actions.systemMessage('Teleporting home...');
      this.close(); return false;
    } else if (ch === 'r') {
      this.push({ kind: 'tp-input' });
    }
    return true;
  }

  private handleTpInputKey(str: string | undefined, key: { name?: string }): boolean {
    if (key.name === 'return') {
      if (this.inputBuf.trim()) {
        const parts = this.inputBuf.trim().split(/\s+/);
        const region = parts[0];
        const x = parts[1] ? parseInt(parts[1]) : undefined;
        const y = parts[2] ? parseInt(parts[2]) : undefined;
        const z = parts[3] ? parseInt(parts[3]) : undefined;
        this.actions.teleportRegion(
          region,
          x !== undefined && !isNaN(x) ? x : undefined,
          y !== undefined && !isNaN(y) ? y : undefined,
          z !== undefined && !isNaN(z) ? z : undefined,
        );
        this.actions.systemMessage(`Teleporting to ${region}...`);
      }
      this.close(); return false;
    }
    if (key.name === 'backspace') {
      this.inputBuf = this.inputBuf.slice(0, -1);
      return true;
    }
    if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
      this.inputBuf += str;
    }
    return true;
  }

  private handleActionsKey(str: string | undefined): boolean {
    const ch = str?.toLowerCase();
    if (ch === 's') {
      this.actions.stand();
      this.actions.systemMessage('Standing up');
      this.close(); return false;
    }
    return true;
  }

  // --- Panel content builders ---
  // Each returns { title, lines, footer } for renderPanel.

  private buildCurrentPanel(maxLines: number): { title: string; lines: PanelLine[]; footer: string } {
    switch (this.current.kind) {
      case 'root':         return this.buildRoot();
      case 'friends':      return this.buildFriends(maxLines);
      case 'friend-act':   return this.buildFriendAct();
      case 'messages':     return this.buildMessages(maxLines);
      case 'conversation': return this.buildConversation(maxLines);
      case 'compose':      return this.buildCompose();
      case 'teleport':     return this.buildTeleport();
      case 'tp-input':     return this.buildTpInput();
      case 'actions':      return this.buildActions();
      case 'profile':      return this.buildProfile(maxLines);
      default:             return { title: 'Menu', lines: [], footer: ' Esc: close' };
    }
  }

  private buildRoot(): { title: string; lines: PanelLine[]; footer: string } {
    const unread = this.unreadCount;
    const badge = unread > 0 ? ` (${unread} new)` : '';
    return {
      title: 'Menu',
      lines: [
        { text: '' },
        { text: '  [F]  Friends' },
        { text: `  [M]  Messages${badge}` },
        { text: '  [T]  Teleport' },
        { text: '  [A]  Actions' },
        { text: '' },
      ],
      footer: ' Esc: close',
    };
  }

  private buildFriends(maxLines: number): { title: string; lines: PanelLine[]; footer: string } {
    if (this.friendsLoading && this.friends.length === 0) {
      return { title: 'Friends', lines: [{ text: '' }, { text: '  Loading...' }, { text: '' }], footer: ' Esc: back' };
    }
    if (this.friends.length === 0) {
      return { title: 'Friends', lines: [{ text: '' }, { text: '  No friends yet' }, { text: '' }], footer: ' Esc: back' };
    }
    const maxVis = Math.max(1, maxLines - 1); // leave blank line at top
    this.ensureVisible(this.friends.length, maxVis);
    const visible = this.friends.slice(this.scrollOffset, this.scrollOffset + maxVis);
    const lines: PanelLine[] = [{ text: '' }];
    for (let i = 0; i < visible.length; i++) {
      const f = visible[i];
      const num = this.scrollOffset + i + 1;
      const dot = f.online ? '●' : '○';
      lines.push({
        text: `  ${num}. ${f.name}  ${dot}`,
        selected: this.scrollOffset + i === this.selectedIdx,
      });
    }
    const more = this.friends.length > this.scrollOffset + maxVis;
    const scrollHint = more ? ' ↑↓:scroll' : '';
    return { title: 'Friends', lines, footer: ` 1-9:select Enter:open${scrollHint} Esc:back` };
  }

  private buildFriendAct(): { title: string; lines: PanelLine[]; footer: string } {
    const name = this.current.name || '?';
    return {
      title: name,
      lines: [
        { text: '' },
        { text: '  [M]  Send message' },
        { text: '  [G]  Go to (fly)' },
        { text: '  [P]  View profile' },
        { text: '' },
      ],
      footer: ' Esc: back',
    };
  }

  private buildMessages(maxLines: number): { title: string; lines: PanelLine[]; footer: string } {
    const convs = this.getConversations();
    if (convs.length === 0) {
      return { title: 'Messages', lines: [{ text: '' }, { text: '  No messages yet' }, { text: '' }], footer: ' Esc: back' };
    }
    const maxVis = Math.max(1, maxLines - 1);
    this.ensureVisible(convs.length, maxVis);
    const visible = convs.slice(this.scrollOffset, this.scrollOffset + maxVis);
    const lines: PanelLine[] = [{ text: '' }];
    for (let i = 0; i < visible.length; i++) {
      const c = visible[i];
      const num = this.scrollOffset + i + 1;
      const badge = c.unread > 0 ? ` (${c.unread})` : '';
      const ago = timeAgo(c.lastTs);
      lines.push({
        text: `  ${num}. ${c.name}${badge}  ${ago}`,
        selected: this.scrollOffset + i === this.selectedIdx,
      });
    }
    const more = convs.length > this.scrollOffset + maxVis;
    const scrollHint = more ? ' ↑↓:scroll' : '';
    return { title: 'Messages', lines, footer: ` 1-9:select Enter:open${scrollHint} Esc:back` };
  }

  private buildConversation(maxLines: number): { title: string; lines: PanelLine[]; footer: string } {
    const msgs = this.getConversationMessages(this.current.uuid!);
    if (msgs.length === 0) {
      return { title: this.current.name || '?', lines: [{ text: '  No messages' }], footer: ' [R]eply [P]rofile Esc:back' };
    }
    // Show most recent messages, scrollable
    const maxVis = Math.max(1, maxLines - 1);
    const maxScroll = Math.max(0, msgs.length - maxVis);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    const start = Math.max(0, msgs.length - maxVis - this.scrollOffset);
    const end = Math.min(msgs.length, start + maxVis);
    const visible = msgs.slice(start, end);
    const lines: PanelLine[] = [{ text: '' }];
    for (const m of visible) {
      const who = m.outgoing ? 'You' : firstName(m.peerName);
      const ago = timeAgo(m.ts);
      lines.push({ text: `  ${who}: ${m.message}  ${ago}` });
    }
    return { title: this.current.name || '?', lines, footer: ' [R]eply [P]rofile ↑↓:scroll Esc:back' };
  }

  private buildCompose(): { title: string; lines: PanelLine[]; footer: string } {
    const name = this.current.name || '?';
    return {
      title: `Message \u203a ${name}`,
      lines: [
        { text: '' },
        { text: `  > ${this.inputBuf}\u2588` },
        { text: '' },
      ],
      footer: ' Enter:send  Esc:cancel',
    };
  }

  private buildTeleport(): { title: string; lines: PanelLine[]; footer: string } {
    return {
      title: 'Teleport',
      lines: [
        { text: '' },
        { text: '  [H]  Home' },
        { text: '  [R]  Region...' },
        { text: '' },
      ],
      footer: ' Esc: back',
    };
  }

  private buildTpInput(): { title: string; lines: PanelLine[]; footer: string } {
    return {
      title: 'Teleport to region',
      lines: [
        { text: '' },
        { text: `  Region: ${this.inputBuf}\u2588` },
        { text: '  (name, or: name x y z)' },
        { text: '' },
      ],
      footer: ' Enter:go  Esc:cancel',
    };
  }

  private buildActions(): { title: string; lines: PanelLine[]; footer: string } {
    return {
      title: 'Actions',
      lines: [
        { text: '' },
        { text: '  [S]  Stand up' },
        { text: '' },
      ],
      footer: ' Esc: back',
    };
  }

  private buildProfile(maxLines: number): { title: string; lines: PanelLine[]; footer: string } {
    const lines: PanelLine[] = [{ text: '' }];
    const vis = this.profileLines.slice(0, Math.max(1, maxLines - 1));
    for (const l of vis) {
      lines.push({ text: `  ${l}` });
    }
    lines.push({ text: '' });
    return { title: this.current.name || 'Profile', lines, footer: ' any key: back' };
  }

  // --- Rendering ---
  private prevPanelRows = 0; // track previous render height to clear stale rows

  render(layout: ScreenLayout): string {
    if (!this.isOpen) return '';
    const panelW = Math.min(52, layout.totalCols - 4);
    const maxPanelH = Math.max(6, layout.fpRows - 2);
    const maxContent = maxPanelH - 3; // top border + footer + bottom border
    const { title, lines, footer } = this.buildCurrentPanel(maxContent);
    const clampedLines = lines.slice(0, maxContent);
    const totalRows = clampedLines.length + 3; // top border + content + footer + bottom border

    let buf = this.drawPanel(layout, panelW, title, clampedLines, footer);

    // Clear stale rows from previous larger panel
    if (this.prevPanelRows > totalRows) {
      const left = Math.max(0, Math.floor((layout.totalCols - panelW) / 2));
      const startClear = layout.fpTop + 1 + totalRows;
      for (let r = startClear; r < layout.fpTop + 1 + this.prevPanelRows; r++) {
        buf += moveTo(r, left) + ' '.repeat(panelW);
      }
    }
    this.prevPanelRows = totalRows;

    return buf;
  }

  private drawPanel(
    layout: ScreenLayout,
    panelW: number,
    title: string,
    lines: PanelLine[],
    footer: string,
  ): string {
    const inner = panelW - 2;
    const left = Math.max(0, Math.floor((layout.totalCols - panelW) / 2));
    const top = layout.fpTop + 1;
    const bw = isBwMode();

    let buf = '';
    let r = top;

    // --- Top border ---
    const titleTrunc = title.slice(0, inner - 4);
    const barLen = Math.max(0, inner - titleTrunc.length - 3);
    if (bw) {
      buf += moveTo(r++, left) + '\u250c\u2500 ' + titleTrunc + ' ' + '\u2500'.repeat(barLen) + '\u2510';
    } else {
      buf += moveTo(r++, left)
        + bgColor(PBG) + fgColor(BORDER_FG)
        + '\u250c\u2500 '
        + fgColor(PFG) + BOLD + titleTrunc + RESET
        + bgColor(PBG) + fgColor(BORDER_FG)
        + ' ' + '\u2500'.repeat(barLen) + '\u2510'
        + RESET;
    }

    // --- Content lines ---
    for (const line of lines) {
      const raw = line.text.slice(0, inner);
      const padded = raw.padEnd(inner);
      buf += moveTo(r++, left);
      if (bw) {
        if (line.selected) {
          buf += '\u2502' + REVERSE + padded + RESET + '\u2502';
        } else {
          buf += '\u2502' + padded + '\u2502';
        }
      } else {
        buf += bgColor(PBG) + fgColor(BORDER_FG) + '\u2502';
        if (line.selected) {
          buf += bgColor(PFG) + fgColor(PBG) + padded;
        } else {
          buf += fgColor(PFG) + this.highlightBracketKeys(padded);
        }
        buf += RESET + bgColor(PBG) + fgColor(BORDER_FG) + '\u2502' + RESET;
      }
    }

    // --- Footer ---
    {
      const padded = footer.slice(0, inner).padEnd(inner);
      buf += moveTo(r++, left);
      if (bw) {
        buf += '\u2502' + DIM + padded + RESET + '\u2502';
      } else {
        buf += bgColor(PBG) + fgColor(BORDER_FG) + '\u2502'
          + fgColor(DIM_FG) + padded
          + fgColor(BORDER_FG) + '\u2502' + RESET;
      }
    }

    // --- Bottom border ---
    buf += moveTo(r++, left);
    if (bw) {
      buf += '\u2514' + '\u2500'.repeat(inner) + '\u2518';
    } else {
      buf += bgColor(PBG) + fgColor(BORDER_FG)
        + '\u2514' + '\u2500'.repeat(inner) + '\u2518'
        + RESET;
    }

    return buf;
  }

  // Highlight [X] bracket-key patterns with bold yellow
  private highlightBracketKeys(text: string): string {
    if (isBwMode()) return text;
    return text.replace(/\[([A-Z0-9])\]/g, (_match, key) => {
      return RESET + bgColor(PBG) + fgColor(KEY_FG) + BOLD + '[' + key + ']' + RESET + bgColor(PBG) + fgColor(PFG);
    });
  }
}
