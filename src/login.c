// login.c — ASCII login form
#include "login.h"
#include "terminal.h"
#include <string.h>
#include <stdio.h>

#define BOLD "\x1b[1m"
#define DIM  "\x1b[2m"
#define REVERSE "\x1b[7m"
#define RESET "\x1b[0m"
#define RED "\x1b[31m"
#define YELLOW "\x1b[33m"

void login_state_init(LoginState *s) {
    memset(s, 0, sizeof(*s));
    strcpy(s->last_name, "");
    s->active_field = FIELD_FIRST_NAME;
}

void login_render(const LoginState *s, int cols, int rows) {
    int box_w = 44, box_h = 14;
    int start_col = (cols - box_w) / 2;
    int start_row = (rows - box_h) / 2;
    if (start_col < 0) start_col = 0;
    if (start_row < 0) start_row = 0;

    term_buf_clear();
    term_buf_append("\x1b[2J"); // clear

    // Title
    term_buf_append_move(start_row, start_col);
    term_buf_appendf(BOLD "  SL-TUI: Second Life Terminal Client" RESET);
    term_buf_append_move(start_row + 1, start_col);
    term_buf_appendf(DIM "  ");
    for (int i = 0; i < box_w - 4; i++) term_buf_append("\xe2\x94\x80"); // ─
    term_buf_append(RESET);

    // Fields
    struct { const char *label; const char *value; LoginField key; int mask; } fields[] = {
        {"First Name", s->first_name, FIELD_FIRST_NAME, 0},
        {"Last Name ", s->last_name, FIELD_LAST_NAME, 0},
        {"Password  ", s->password, FIELD_PASSWORD, 1},
    };

    for (int i = 0; i < 3; i++) {
        int row = start_row + 3 + i * 2;
        int active = (s->active_field == fields[i].key);
        int vlen = strlen(fields[i].value);

        term_buf_append_move(row, start_col + 2);
        term_buf_appendf("%s%s: " RESET, active ? BOLD : DIM, fields[i].label);
        term_buf_append(active ? REVERSE : "");
        term_buf_append(" ");
        if (fields[i].mask) {
            for (int j = 0; j < vlen; j++) term_buf_append("*");
        } else {
            term_buf_append(fields[i].value);
        }
        if (active) term_buf_append("\xe2\x96\x88"); // █ cursor
        int pad = 20 - vlen;
        if (pad < 0) pad = 0;
        for (int j = 0; j < pad; j++) term_buf_append(" ");
        term_buf_append(RESET);
    }

    // Error
    if (s->error[0]) {
        term_buf_append_move(start_row + 10, start_col + 2);
        term_buf_appendf(RED "%s" RESET, s->error);
    }

    // Hints
    int has_saved = strlen(s->first_name) > 0 && strlen(s->password) > 0;
    if (has_saved) {
        term_buf_append_move(start_row + 11, start_col + 2);
        term_buf_appendf(YELLOW "Saved credentials loaded. Press Enter to login." RESET);
    }
    term_buf_append_move(start_row + 12, start_col + 2);
    term_buf_appendf(DIM "Tab: next field  Enter: login  Ctrl+C: quit" RESET);

    term_buf_flush();
}

void login_render_loading(int cols, int rows, const char *message) {
    if (!message) message = "Connecting to Second Life...";
    int msg_len = strlen(message);
    int start_col = (cols - msg_len - 4) / 2;
    int start_row = rows / 2;
    if (start_col < 0) start_col = 0;

    term_buf_clear();
    term_buf_append("\x1b[2J");
    term_buf_append_move(start_row, start_col);
    term_buf_appendf(BOLD "  %s" RESET, message);
    term_buf_append_move(start_row + 1, start_col);
    term_buf_appendf(DIM "  Please wait..." RESET);
    term_buf_flush();
}

void login_next_field(LoginState *s) {
    s->active_field = (s->active_field + 1) % 3;
}

void login_append_char(LoginState *s, char c) {
    char *field;
    int max_len;
    switch (s->active_field) {
        case FIELD_FIRST_NAME: field = s->first_name; max_len = sizeof(s->first_name) - 1; break;
        case FIELD_LAST_NAME:  field = s->last_name;  max_len = sizeof(s->last_name) - 1;  break;
        case FIELD_PASSWORD:   field = s->password;   max_len = sizeof(s->password) - 1;   break;
        default: return;
    }
    int len = strlen(field);
    if (len < max_len) {
        field[len] = c;
        field[len + 1] = '\0';
    }
}

void login_backspace(LoginState *s) {
    char *field;
    switch (s->active_field) {
        case FIELD_FIRST_NAME: field = s->first_name; break;
        case FIELD_LAST_NAME:  field = s->last_name;  break;
        case FIELD_PASSWORD:   field = s->password;   break;
        default: return;
    }
    int len = strlen(field);
    if (len > 0) field[len - 1] = '\0';
}
