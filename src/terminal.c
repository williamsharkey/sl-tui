// terminal.c — Low-level terminal control
#include "terminal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <termios.h>
#include <sys/ioctl.h>

static struct termios orig_termios;
static bool raw_mode_active = false;

// Output buffer (64KB should be plenty for a single frame)
#define BUF_CAP (256 * 1024)
static char out_buf[BUF_CAP];
static int out_len = 0;

void term_get_size(int *cols, int *rows) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0) {
        *cols = ws.ws_col;
        *rows = ws.ws_row;
    } else {
        *cols = 80;
        *rows = 24;
    }
}

void term_enter_alt_screen(void) {
    write(STDOUT_FILENO, "\x1b[?1049h\x1b[?25l\x1b[2J", 20);
}

void term_exit_alt_screen(void) {
    write(STDOUT_FILENO, "\x1b[?25h\x1b[?1049l", 16);
}

void term_hide_cursor(void) {
    write(STDOUT_FILENO, "\x1b[?25l", 6);
}

void term_show_cursor(void) {
    write(STDOUT_FILENO, "\x1b[?25h", 6);
}

void term_clear_screen(void) {
    write(STDOUT_FILENO, "\x1b[2J", 4);
}

void term_move_to(int row, int col) {
    char buf[32];
    int n = snprintf(buf, sizeof(buf), "\x1b[%d;%dH", row + 1, col + 1);
    write(STDOUT_FILENO, buf, n);
}

void term_enable_raw_mode(void) {
    if (raw_mode_active) return;
    tcgetattr(STDIN_FILENO, &orig_termios);
    struct termios raw = orig_termios;
    raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    raw.c_oflag &= ~(OPOST);
    raw.c_cflag |= (CS8);
    raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw);
    raw_mode_active = true;
}

void term_disable_raw_mode(void) {
    if (!raw_mode_active) return;
    tcsetattr(STDIN_FILENO, TCSAFLUSH, &orig_termios);
    raw_mode_active = false;
}

void term_flush(void) {
    fflush(stdout);
}

// Buffered output
void term_buf_clear(void) {
    out_len = 0;
}

void term_buf_append(const char *s) {
    int slen = strlen(s);
    if (out_len + slen >= BUF_CAP) return; // silently drop if overflow
    memcpy(out_buf + out_len, s, slen);
    out_len += slen;
}

void term_buf_appendf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int avail = BUF_CAP - out_len;
    if (avail <= 0) { va_end(ap); return; }
    int n = vsnprintf(out_buf + out_len, avail, fmt, ap);
    va_end(ap);
    if (n > 0 && n < avail) out_len += n;
}

void term_buf_append_move(int row, int col) {
    term_buf_appendf("\x1b[%d;%dH", row + 1, col + 1);
}

void term_buf_flush(void) {
    if (out_len > 0) {
        write(STDOUT_FILENO, out_buf, out_len);
        out_len = 0;
    }
}

const char *term_buf_get(void) {
    out_buf[out_len] = '\0';
    return out_buf;
}

int term_buf_len(void) {
    return out_len;
}
