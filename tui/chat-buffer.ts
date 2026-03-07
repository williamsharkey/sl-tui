// chat-buffer.ts — Scrollable chat history ring buffer

export class ChatBuffer {
  private messages: string[] = [];
  private scrollOffset = 0;
  readonly maxMessages: number;

  constructor(maxMessages = 200) {
    this.maxMessages = maxMessages;
  }

  add(from: string, message: string): void {
    const line = `${from}: ${message}`;
    this.messages.push(line);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    // Auto-scroll to bottom on new message
    this.scrollOffset = 0;
  }

  addSystem(message: string): void {
    this.messages.push(`* ${message}`);
    if (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    this.scrollOffset = 0;
  }

  getVisibleLines(count: number): string[] {
    const end = this.messages.length - this.scrollOffset;
    const start = Math.max(0, end - count);
    return this.messages.slice(start, end);
  }

  scrollUp(lines = 1): void {
    this.scrollOffset = Math.min(
      this.scrollOffset + lines,
      Math.max(0, this.messages.length - 1),
    );
  }

  scrollDown(lines = 1): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
  }

  get length(): number {
    return this.messages.length;
  }

  get isScrolledUp(): boolean {
    return this.scrollOffset > 0;
  }
}
