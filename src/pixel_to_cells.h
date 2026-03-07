// pixel_to_cells.h — Convert RGBA pixel buffer to Cell[] using Unicode quadrant blocks
#ifndef PIXEL_TO_CELLS_H
#define PIXEL_TO_CELLS_H

#include "grid.h"

// Convert pixel buffer (pw x ph) into cell grid (pw/2 x ph/2).
// bg_r/g/b is used for transparent (alpha=0) pixels.
// Caller must grid_frame_destroy() the result.
GridFrame *pixels_to_cells(
    const uint8_t *pixels, int pw, int ph,
    uint8_t bg_r, uint8_t bg_g, uint8_t bg_b
);

#endif
