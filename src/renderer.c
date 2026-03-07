// renderer.c — Render GridFrame/cells to terminal escape sequences
#include "renderer.h"
#include "terminal.h"
#include "color.h"
#include <string.h>
#include <stdio.h>

#define RESET "\x1b[0m"
#define REVERSE "\x1b[7m"
#define RESET_BG "\x1b[49m"
#define DIM_FG "\x1b[2m"

// Terrain chars that are transparent on minimap
static int is_minimap_terrain(const char *ch) {
    return (ch[0] == '.' || ch[0] == ',' || ch[0] == '~' ||
            ch[0] == ':' || ch[0] == ' ') && ch[1] == '\0';
}

// Check if a screen cell falls inside the minimap region
static int in_minimap(const ScreenLayout *layout, int screen_row, int col) {
    return screen_row >= layout->minimap_top &&
           screen_row < layout->minimap_top + layout->minimap_rows &&
           col >= layout->minimap_left;
}

void render_fp_view(const ScreenLayout *layout, const GridFrame *frame) {
    char fg_buf[32], bg_buf[32];
    RGB last_fg = {0, 0, 0}, last_bg = {0, 0, 0};
    int first = 1;

    for (int row = 0; row < layout->fp_rows && row < frame->rows; row++) {
        int screen_row = layout->fp_top + row;
        term_buf_append_move(screen_row, 0);

        // How many cols to render on this row (skip minimap region)
        int max_col = layout->fp_cols;
        if (in_minimap(layout, screen_row, layout->minimap_left))
            max_col = layout->minimap_left;

        first = 1;
        for (int col = 0; col < max_col && col < frame->cols; col++) {
            const Cell *c = &frame->cells[row * frame->cols + col];
            if (first || c->fg.r != last_fg.r || c->fg.g != last_fg.g || c->fg.b != last_fg.b) {
                fg_color(fg_buf, c->fg);
                term_buf_append(fg_buf);
                last_fg = c->fg;
            }
            if (first || c->bg.r != last_bg.r || c->bg.g != last_bg.g || c->bg.b != last_bg.b) {
                bg_color(bg_buf, c->bg);
                term_buf_append(bg_buf);
                last_bg = c->bg;
            }
            first = 0;
            term_buf_append(c->ch);
        }
        term_buf_append(RESET);
    }
}

void render_fp_delta(const ScreenLayout *layout, const CellDelta *deltas, int count) {
    char fg_buf[32], bg_buf[32];

    for (int i = 0; i < count; i++) {
        const CellDelta *d = &deltas[i];
        int screen_row = layout->fp_top + d->row;
        int screen_col = d->col;
        // Skip cells that fall inside the minimap region
        if (in_minimap(layout, screen_row, screen_col)) continue;
        term_buf_append_move(screen_row, screen_col);
        fg_color(fg_buf, d->cell.fg);
        bg_color(bg_buf, d->cell.bg);
        term_buf_append(fg_buf);
        term_buf_append(bg_buf);
        term_buf_append(d->cell.ch);
        term_buf_append(RESET);
    }
}

void render_minimap(const ScreenLayout *layout, const GridFrame *frame) {
    char fg_buf[32], bg_buf[32];
    int m_top = layout->minimap_top;
    int m_left = layout->minimap_left;
    int m_rows = layout->minimap_rows < frame->rows ? layout->minimap_rows : frame->rows;
    int m_cols = layout->minimap_cols < frame->cols ? layout->minimap_cols : frame->cols;

    // Dark semi-transparent background for readability
    static const RGB mm_bg = {0x10, 0x10, 0x18};

    for (int row = 0; row < m_rows; row++) {
        term_buf_append_move(m_top + row, m_left);
        for (int col = 0; col < m_cols; col++) {
            const Cell *c = &frame->cells[row * frame->cols + col];
            int is_border = (row == 0 || row == m_rows - 1 || col == 0 || col == m_cols - 1);

            if (is_border && is_minimap_terrain(c->ch)) {
                // Dim border dot on dark bg
                bg_color(bg_buf, mm_bg);
                term_buf_append(bg_buf);
                term_buf_appendf("\x1b[38;2;80;80;80m\xc2\xb7");
            } else {
                fg_color(fg_buf, c->fg);
                term_buf_append(fg_buf);
                // Content (avatars, compass, etc.) gets dark bg; terrain keeps its own colors
                if (!is_minimap_terrain(c->ch)) {
                    bg_color(bg_buf, mm_bg);
                } else {
                    bg_color(bg_buf, mm_bg);
                }
                term_buf_append(bg_buf);
                term_buf_append(c->ch);
            }
        }
        term_buf_append(RESET);
    }
}

void render_status_bar(const ScreenLayout *layout, const char *region,
                       float x, float y, float z, bool flying) {
    char line[512];
    int n = snprintf(line, sizeof(line), " %s (%.0f, %.0f, %.0f)%s ",
                     region, x, y, z, flying ? " [FLY]" : "");

    // Pad to full width
    while (n < layout->total_cols && n < (int)sizeof(line) - 1)
        line[n++] = ' ';
    line[n] = '\0';

    term_buf_append_move(layout->status_row, 0);
    term_buf_append(REVERSE);
    term_buf_append(line);
    term_buf_append(RESET);
}

void render_separator(const ScreenLayout *layout) {
    term_buf_append_move(layout->separator_row, 0);
    term_buf_appendf("\x1b[38;2;102;102;102m");
    for (int i = 0; i < layout->total_cols; i++)
        term_buf_append("\xe2\x94\x80"); // ─
    term_buf_append(RESET);
}

void render_chat_lines(const ScreenLayout *layout, const char **lines, int nlines) {
    for (int i = 0; i < layout->chat_lines; i++) {
        term_buf_append_move(layout->chat_top + i, 0);
        if (i < nlines && lines[i]) {
            // Truncate/pad to total_cols
            int len = strlen(lines[i]);
            if (len > layout->total_cols) {
                char tmp[1024];
                snprintf(tmp, sizeof(tmp), "%.*s", layout->total_cols, lines[i]);
                term_buf_append(tmp);
            } else {
                term_buf_append(lines[i]);
                // Pad
                for (int j = len; j < layout->total_cols; j++)
                    term_buf_append(" ");
            }
        } else {
            for (int j = 0; j < layout->total_cols; j++)
                term_buf_append(" ");
        }
    }
}

void render_input_line(const ScreenLayout *layout, const char *mode,
                       const char *input_text) {
    char line[1024] = {0};

    if (strcmp(mode, "chat-input") == 0) {
        snprintf(line, sizeof(line), "Say: %s\xe2\x96\x88", input_text);
    } else if (strcmp(mode, "grid") == 0) {
        snprintf(line, sizeof(line),
                 " W/S:fwd/back A/D:strafe \xe2\x86\x90\xe2\x86\x92:turn Space:jump F:fly V:dither Enter:chat Q:quit");
    }

    // Pad to full width
    int len = strlen(line);
    while (len < layout->total_cols && len < (int)sizeof(line) - 1)
        line[len++] = ' ';
    line[len] = '\0';

    term_buf_append_move(layout->input_row, 0);
    term_buf_append(REVERSE);
    // Truncate to total_cols
    if (len > layout->total_cols) line[layout->total_cols] = '\0';
    term_buf_append(line);
    term_buf_append(RESET);
}
