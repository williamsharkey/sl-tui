// grid.h — Cell grid, frame diffing, minimap + FP projection
#ifndef GRID_H
#define GRID_H

#include "color.h"
#include <stdbool.h>
#include <math.h>

// A single terminal cell
typedef struct {
    char ch[5];  // UTF-8 character (up to 4 bytes + null)
    RGB fg;
    RGB bg;
} Cell;

typedef struct {
    Cell *cells;
    int cols;
    int rows;
} GridFrame;

// Per-cell delta for incremental rendering
typedef struct {
    int idx;
    int col;
    int row;
    Cell cell;
} CellDelta;

typedef struct {
    float x, y, z;
    float yaw;
    bool is_self;
    char uuid[40];
    char first_name[64];
    char last_name[64];
} AvatarData;

typedef struct {
    float x, y, z;
    float scale_x, scale_y, scale_z;
    bool is_tree;
    char uuid[40];
} ObjectData;

// Terrain height callback
typedef float (*TerrainFn)(int x, int y, void *ctx);

// Bilinear-interpolated terrain sample at float coordinates
static inline float terrain_sample(TerrainFn fn, void *ctx, float fx, float fy) {
    int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
    int x1 = x0 + 1, y1 = y0 + 1;
    if (x0 < 0) x0 = 0; if (x1 > 255) x1 = 255;
    if (y0 < 0) y0 = 0; if (y1 > 255) y1 = 255;
    float tx = fx - floorf(fx), ty = fy - floorf(fy);
    float h00 = fn(x0, y0, ctx), h10 = fn(x1, y0, ctx);
    float h01 = fn(x0, y1, ctx), h11 = fn(x1, y1, ctx);
    float h0 = h00 + (h10 - h00) * tx;
    float h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * ty;
}

// FP pixel buffer (2x resolution for quadrant block rendering)
typedef struct {
    uint8_t *pixels;    // RGBA, (pw * ph * 4)
    float *depth;       // per-pixel depth
    int pw, ph;
} FPPixelBuffer;

// Create/destroy frames
GridFrame *grid_frame_create(int cols, int rows);
void grid_frame_destroy(GridFrame *f);

// Diff two frames, returns array of CellDelta (caller frees). Sets *count.
CellDelta *grid_diff_frames(const GridFrame *prev, const GridFrame *next, int *count);

// Minimap projection
GridFrame *project_minimap(
    TerrainFn terrain, void *ctx,
    const AvatarData *avatars, int nav,
    const ObjectData *objects, int nobj,
    int cols, int rows,
    float self_x, float self_y, float self_z,
    float water_height, float meters_per_cell,
    float yaw, bool flying
);

// First-person projection
GridFrame *project_first_person(
    TerrainFn terrain, void *ctx,
    const AvatarData *avatars, int nav,
    const ObjectData *objects, int nobj,
    float self_x, float self_y, float self_z,
    float yaw, float water_height,
    int cols, int rows,
    float dither_phase  // 0 = off
);

// Pixel buffer management
FPPixelBuffer *fp_pixel_buf_create(int pw, int ph);
void fp_pixel_buf_destroy(FPPixelBuffer *buf);
void fp_pixel_buf_clear(FPPixelBuffer *buf);

#endif
