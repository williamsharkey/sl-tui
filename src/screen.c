// screen.c — Terminal layout calculator
#include "screen.h"

static int imax(int a, int b) { return a > b ? a : b; }

ScreenLayout compute_layout(int cols, int rows) {
    ScreenLayout l;
    l.status_row = 0;
    l.input_row = rows - 1;
    l.chat_lines = 5;
    l.separator_row = rows - 7;
    l.chat_top = l.separator_row + 1;
    l.chat_bottom = rows - 2;

    l.fp_top = 1;
    l.fp_bottom = imax(1, l.separator_row - 1);
    l.fp_rows = imax(1, l.fp_bottom - l.fp_top + 1);
    l.fp_cols = cols;

    l.minimap_cols = imax(8, cols * 2 / 3);
    l.minimap_rows = imax(4, l.fp_rows * 2 / 3);
    l.minimap_left = cols - l.minimap_cols;
    l.minimap_top = l.fp_top;

    l.total_cols = cols;
    l.total_rows = rows;
    return l;
}
