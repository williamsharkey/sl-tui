// terminal.h — Low-level terminal control (alt screen, cursor, raw mode)
#ifndef TERMINAL_H
#define TERMINAL_H

#include <stdbool.h>

void term_get_size(int *cols, int *rows);
void term_enter_alt_screen(void);
void term_exit_alt_screen(void);
void term_hide_cursor(void);
void term_show_cursor(void);
void term_clear_screen(void);
void term_move_to(int row, int col); // 0-based
void term_enable_raw_mode(void);
void term_disable_raw_mode(void);
void term_flush(void);

// Buffered output — accumulate escape sequences, flush once
void term_buf_clear(void);
void term_buf_append(const char *s);
void term_buf_appendf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void term_buf_append_move(int row, int col);
void term_buf_flush(void);
const char *term_buf_get(void);
int term_buf_len(void);

#endif
