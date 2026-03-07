// screen.h — Terminal layout calculator (port of tui/screen.ts)
#ifndef SCREEN_H
#define SCREEN_H

typedef struct {
    int status_row;
    int fp_top;
    int fp_bottom;
    int fp_rows;
    int fp_cols;
    int minimap_top;
    int minimap_left;
    int minimap_rows;
    int minimap_cols;
    int separator_row;
    int chat_top;
    int chat_bottom;
    int chat_lines;
    int input_row;
    int total_cols;
    int total_rows;
} ScreenLayout;

ScreenLayout compute_layout(int cols, int rows);

#endif
