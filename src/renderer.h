// renderer.h — Render GridFrame/cells to terminal escape sequences
#ifndef RENDERER_H
#define RENDERER_H

#include "grid.h"
#include "screen.h"

// Render FP view cells to terminal buffer
void render_fp_view(const ScreenLayout *layout, const GridFrame *frame);

// Render FP delta (only changed cells)
void render_fp_delta(const ScreenLayout *layout, const CellDelta *deltas, int count);

// Render minimap overlay (transparent — only non-terrain content)
void render_minimap(const ScreenLayout *layout, const GridFrame *frame);

// Render status bar
void render_status_bar(const ScreenLayout *layout, const char *region,
                       float x, float y, float z, bool flying);

// Render separator line
void render_separator(const ScreenLayout *layout);

// Render chat lines
void render_chat_lines(const ScreenLayout *layout, const char **lines, int nlines);

// Render input line
void render_input_line(const ScreenLayout *layout, const char *mode,
                       const char *input_text);

#endif
