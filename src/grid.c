// grid.c — Cell grid, frame diffing, minimap + FP voxel raycaster
#include "grid.h"
#include "pixel_to_cells.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ─── Frame management ─────────────────────────────────────────

GridFrame *grid_frame_create(int cols, int rows) {
    GridFrame *f = calloc(1, sizeof(GridFrame));
    f->cols = cols;
    f->rows = rows;
    f->cells = calloc(cols * rows, sizeof(Cell));
    for (int i = 0; i < cols * rows; i++) {
        strcpy(f->cells[i].ch, " ");
        f->cells[i].fg = (RGB){0x33, 0x66, 0x33};
        f->cells[i].bg = (RGB){0xf0, 0xee, 0xdc};
    }
    return f;
}

void grid_frame_destroy(GridFrame *f) {
    if (!f) return;
    free(f->cells);
    free(f);
}

CellDelta *grid_diff_frames(const GridFrame *prev, const GridFrame *next, int *count) {
    *count = 0;
    int len = prev->cols * prev->rows;
    if (len != next->cols * next->rows) len = 0;

    // First pass: count changes
    int n = 0;
    for (int i = 0; i < len; i++) {
        const Cell *p = &prev->cells[i];
        const Cell *nx = &next->cells[i];
        if (strcmp(p->ch, nx->ch) != 0 ||
            p->fg.r != nx->fg.r || p->fg.g != nx->fg.g || p->fg.b != nx->fg.b ||
            p->bg.r != nx->bg.r || p->bg.g != nx->bg.g || p->bg.b != nx->bg.b) {
            n++;
        }
    }
    if (n == 0) return NULL;

    CellDelta *deltas = malloc(n * sizeof(CellDelta));
    int di = 0;
    for (int i = 0; i < len; i++) {
        const Cell *p = &prev->cells[i];
        const Cell *nx = &next->cells[i];
        if (strcmp(p->ch, nx->ch) != 0 ||
            p->fg.r != nx->fg.r || p->fg.g != nx->fg.g || p->fg.b != nx->fg.b ||
            p->bg.r != nx->bg.r || p->bg.g != nx->bg.g || p->bg.b != nx->bg.b) {
            deltas[di].idx = i;
            deltas[di].row = i / next->cols;
            deltas[di].col = i % next->cols;
            deltas[di].cell = *nx;
            di++;
        }
    }
    *count = n;
    return deltas;
}

// ─── FP Pixel Buffer ──────────────────────────────────────────

static const RGB SKY_RGB = {0x1a, 0x1a, 0x2e};
static const RGB HORIZON_RGB = {0x55, 0x55, 0x66};

FPPixelBuffer *fp_pixel_buf_create(int pw, int ph) {
    FPPixelBuffer *buf = calloc(1, sizeof(FPPixelBuffer));
    buf->pw = pw;
    buf->ph = ph;
    buf->pixels = calloc(pw * ph * 4, 1);
    buf->depth = malloc(pw * ph * sizeof(float));
    return buf;
}

void fp_pixel_buf_destroy(FPPixelBuffer *buf) {
    if (!buf) return;
    free(buf->pixels);
    free(buf->depth);
    free(buf);
}

void fp_pixel_buf_clear(FPPixelBuffer *buf) {
    int n = buf->pw * buf->ph;
    for (int i = 0; i < n; i++) {
        buf->depth[i] = 1e30f;
        int ci = i * 4;
        buf->pixels[ci]     = SKY_RGB.r;
        buf->pixels[ci + 1] = SKY_RGB.g;
        buf->pixels[ci + 2] = SKY_RGB.b;
        buf->pixels[ci + 3] = 255;
    }
}

static void set_fp_pixel(FPPixelBuffer *buf, int px, int py,
                          uint8_t r, uint8_t g, uint8_t b, float pix_depth) {
    if (px < 0 || px >= buf->pw || py < 0 || py >= buf->ph) return;
    int idx = py * buf->pw + px;
    if (pix_depth >= buf->depth[idx]) return;
    int ci = idx * 4;
    buf->pixels[ci]     = r;
    buf->pixels[ci + 1] = g;
    buf->pixels[ci + 2] = b;
    buf->pixels[ci + 3] = 255;
    buf->depth[idx] = pix_depth;
}

// ─── Dither noise ─────────────────────────────────────────────

static void dither_noise(float x, float y, float phase, float *dx, float *dy) {
    float s1 = sinf(x * 2.8f + phase * 1.3f) * cosf(y * 3.6f + phase * 0.7f);
    float s2 = sinf(y * 2.4f - phase * 1.1f) * cosf(x * 3.2f - phase * 0.9f);
    float s3 = sinf((x + y) * 1.6f + phase * 2.1f) * 0.5f;
    float s4 = cosf((x - y) * 2.0f + phase * 1.7f) * 0.5f;
    *dx = (s1 + s3) * 0.6f;
    *dy = (s2 + s4) * 0.6f;
}

// ─── Avatar pixel silhouette ──────────────────────────────────

static void render_pixel_avatar(
    FPPixelBuffer *buf, int pw __attribute__((unused)), int ph __attribute__((unused)),
    int center_px, int head_py, int fig_h,
    uint8_t r, uint8_t g, uint8_t b, float av_depth
) {
    if (fig_h <= 2) {
        for (int dy = 0; dy < fig_h; dy++)
            set_fp_pixel(buf, center_px, head_py + dy, r, g, b, av_depth);
        return;
    }

    int head_h = (int)(fig_h * 0.15f + 0.5f); if (head_h < 1) head_h = 1;
    int head_w = (int)(fig_h * 0.12f + 0.5f); if (head_w < 1) head_w = 1;
    int torso_h = (int)(fig_h * 0.35f + 0.5f); if (torso_h < 1) torso_h = 1;
    int torso_w = (int)(fig_h * 0.18f + 0.5f); if (torso_w < 1) torso_w = 1;
    int arm_w = (int)(fig_h * 0.12f + 0.5f);
    int leg_h = fig_h - head_h - torso_h;
    int leg_w = (int)(fig_h * 0.08f + 0.5f); if (leg_w < 1) leg_w = 1;

    int py = head_py;

    // Head
    for (int dy = 0; dy < head_h; dy++, py++) {
        int w = (dy == 0 || dy == head_h - 1) ? (head_w > 1 ? head_w - 1 : 1) : head_w;
        for (int dx = -w; dx <= w; dx++) {
            uint8_t hr = r + 20 > 255 ? 255 : r + 20;
            uint8_t hg = g + 15 > 255 ? 255 : g + 15;
            uint8_t hb = b + 10 > 255 ? 255 : b + 10;
            set_fp_pixel(buf, center_px + dx, py, hr, hg, hb, av_depth);
        }
    }

    // Torso + arms
    int arm_row = py + (int)(torso_h * 0.3f);
    for (int dy = 0; dy < torso_h && py < head_py + fig_h; dy++, py++) {
        for (int dx = -torso_w; dx <= torso_w; dx++)
            set_fp_pixel(buf, center_px + dx, py, r, g, b, av_depth);
        if (py >= arm_row && py < arm_row + (int)(torso_h * 0.4f + 0.5f)) {
            for (int side = -1; side <= 1; side += 2) {
                for (int ax = 1; ax <= arm_w; ax++) {
                    uint8_t ar = r > 10 ? r - 10 : 0;
                    uint8_t ag = g > 10 ? g - 10 : 0;
                    uint8_t ab = b > 10 ? b - 10 : 0;
                    set_fp_pixel(buf, center_px + side * (torso_w + ax), py, ar, ag, ab, av_depth);
                }
            }
        }
    }

    // Legs
    for (int dy = 0; dy < leg_h && py < head_py + fig_h; dy++, py++) {
        int gap = dy < (int)(fig_h * 0.05f + 0.5f) ? dy : (int)(fig_h * 0.05f + 0.5f);
        gap += 1;
        for (int side = -1; side <= 1; side += 2) {
            int lc = center_px + side * gap;
            for (int dx = -leg_w; dx <= leg_w; dx++) {
                uint8_t lr = r > 5 ? r - 5 : 0;
                uint8_t lg = g > 5 ? g - 5 : 0;
                uint8_t lb = b > 5 ? b - 5 : 0;
                set_fp_pixel(buf, lc + dx, py, lr, lg, lb, av_depth);
            }
        }
    }
}

// ─── First-person voxel raycaster ─────────────────────────────

// Reusable pixel buffer
static FPPixelBuffer *fp_buf = NULL;

GridFrame *project_first_person(
    TerrainFn terrain, void *ctx,
    const AvatarData *avatars, int nav,
    const ObjectData *objects, int nobj,
    float self_x, float self_y, float self_z,
    float yaw, float water_height,
    int cols, int rows,
    float dither_phase
) {
    int pw = cols * 2;
    int ph = rows * 2;

    // (Re)allocate pixel buffer if needed
    if (!fp_buf || fp_buf->pw != pw || fp_buf->ph != ph) {
        fp_pixel_buf_destroy(fp_buf);
        fp_buf = fp_pixel_buf_create(pw, ph);
    }
    fp_pixel_buf_clear(fp_buf);

    int dither = dither_phase > 0.0f;

    float fwd_x = cosf(yaw), fwd_y = sinf(yaw);
    float right_x = sinf(yaw), right_y = -cosf(yaw);

    float MAX_DEPTH = 96.0f;
    float FOV = (float)(M_PI / 3.0);
    float HALF_FOV = FOV / 2.0f;
    float NEAR = 1.0f;
    float CAMERA_H = self_z;
    int HORIZON = ph / 2;

    // Per-column occlusion
    int *top_drawn = calloc(pw, sizeof(int));
    for (int i = 0; i < pw; i++) top_drawn[i] = ph;

    // Voxel raycasting — front-to-back with bilinear terrain sampling
    for (int pcol = 0; pcol < pw; pcol++) {
        float screen_frac = (float)pcol / (float)(pw - 1);
        float ray_angle = yaw + HALF_FOV - screen_frac * FOV;
        float ray_dx = cosf(ray_angle);
        float ray_dy = sinf(ray_angle);
        float cos_corr = cosf(ray_angle - yaw);

        float depth = NEAR;
        // Use adaptive step: never larger than 0.5 grid cells to avoid gaps
        float step = 0.4f;

        while (depth < MAX_DEPTH && top_drawn[pcol] > 0) {
            float wx = self_x + ray_dx * depth;
            float wy = self_y + ray_dy * depth;

            float sx = wx, sy = wy;
            if (dither) {
                float scale = depth / 20.0f;
                if (scale > 1.0f) scale = 1.0f;
                float ddx, ddy;
                dither_noise(wx * 0.6f, wy * 0.6f, dither_phase, &ddx, &ddy);
                sx += ddx * scale;
                sy += ddy * scale;
            }

            if (sx >= 0 && sx < 255.5f && sy >= 0 && sy < 255.5f) {
                float h = terrain_sample(terrain, ctx, sx, sy);
                float corr_depth = depth * cos_corr;
                float height_on_screen = ((CAMERA_H - h) / corr_depth) * ph;
                int screen_py = (int)(HORIZON + height_on_screen + 0.5f);

                if (screen_py < top_drawn[pcol]) {
                    int draw_from = screen_py > 0 ? screen_py : 0;
                    int draw_to = top_drawn[pcol];

                    RGB tc;
                    if (h < water_height)
                        tc = water_pixel_rgb(h, water_height, sx, sy, depth);
                    else
                        tc = terrain_rgb(h, water_height);
                    tc = fog_rgb(tc, depth, MAX_DEPTH);

                    for (int py = draw_from; py < draw_to; py++)
                        set_fp_pixel(fp_buf, pcol, py, tc.r, tc.g, tc.b, corr_depth);

                    top_drawn[pcol] = draw_from;
                }
            }

            // Adaptive step: small near camera, grows slowly with distance
            // but capped so we never skip more than ~0.7 grid cells
            if (depth < 4)       step = 0.25f;
            else if (depth < 15) step = 0.4f;
            else if (depth < 40) step = 0.6f;
            else                 step = 0.8f;
            depth += step;
        }
    }

    // Horizon line
    if (HORIZON >= 0 && HORIZON < ph) {
        for (int pcol = 0; pcol < pw; pcol++) {
            if (top_drawn[pcol] > HORIZON)
                set_fp_pixel(fp_buf, pcol, HORIZON, HORIZON_RGB.r, HORIZON_RGB.g, HORIZON_RGB.b, 999.0f);
        }
    }

    // Objects
    for (int i = 0; i < nobj; i++) {
        const ObjectData *obj = &objects[i];
        float dx = obj->x - self_x;
        float dy = obj->y - self_y;
        float fwd_dist = dx * fwd_x + dy * fwd_y;
        if (fwd_dist < NEAR || fwd_dist > MAX_DEPTH) continue;

        float lat_dist = dx * right_x + dy * right_y;
        float angle_off = atan2f(lat_dist, fwd_dist);
        float sf = 0.5f + angle_off / FOV;
        int spx = (int)(sf * pw + 0.5f);
        if (spx < 0 || spx >= pw) continue;

        float h_on_scr = ((CAMERA_H - (obj->z + obj->scale_z / 2)) / fwd_dist) * ph;
        int spy = (int)(HORIZON + h_on_scr + 0.5f);
        if (spy < 0 || spy >= ph) continue;

        RGB base = obj->is_tree ? (RGB){0x33, 0x66, 0x33} : (RGB){0x88, 0x55, 0x22};
        RGB oc = fog_rgb(base, fwd_dist, MAX_DEPTH);

        int epxh = (int)((obj->scale_z > 0 ? obj->scale_z : 2.0f) / fwd_dist * ph + 0.5f);
        if (epxh < 2) epxh = 2;
        float max_scale = obj->scale_x > obj->scale_y ? obj->scale_x : obj->scale_y;
        int epxw = (int)((max_scale > 0 ? max_scale : 1.0f) / fwd_dist * ph + 0.5f);
        if (epxw < 2) epxw = 2;
        int start_py = spy - epxh + 1; if (start_py < 0) start_py = 0;
        int start_px = spx - epxw / 2;

        for (int py = start_py; py <= spy && py < ph; py++)
            for (int px = start_px; px < start_px + epxw && px < pw; px++)
                set_fp_pixel(fp_buf, px, py, oc.r, oc.g, oc.b, fwd_dist);
    }

    // Avatars
    for (int i = 0; i < nav; i++) {
        const AvatarData *av = &avatars[i];
        if (av->is_self) continue;

        float dx = av->x - self_x, dy = av->y - self_y;
        float fwd_dist = dx * fwd_x + dy * fwd_y;
        if (fwd_dist < NEAR || fwd_dist > MAX_DEPTH) continue;

        float lat_dist = dx * right_x + dy * right_y;
        float angle_off = atan2f(lat_dist, fwd_dist);
        float sf = 0.5f + angle_off / FOV;
        int spx = (int)(sf * pw + 0.5f);
        if (spx < 0 || spx >= pw) continue;

        // Head and feet projection
        float head_h = ((CAMERA_H - (av->z + 2.0f)) / fwd_dist) * ph;
        float feet_h = ((CAMERA_H - av->z) / fwd_dist) * ph;
        int head_py = (int)(HORIZON + head_h + 0.5f);
        int feet_py = (int)(HORIZON + feet_h + 0.5f);
        if (head_py >= ph || feet_py < 0) continue;

        int fig_h = feet_py - head_py + 1;
        if (fig_h < 1) fig_h = 1;

        RGB ac = fog_rgb((RGB){0x30, 0x30, 0x30}, fwd_dist, MAX_DEPTH);
        render_pixel_avatar(fp_buf, pw, ph, spx, head_py, fig_h, ac.r, ac.g, ac.b, fwd_dist);
    }

    free(top_drawn);

    // Convert pixel buffer to cell grid
    GridFrame *result = pixels_to_cells(fp_buf->pixels, pw, ph, SKY_RGB.r, SKY_RGB.g, SKY_RGB.b);
    return result;
}

// ─── Minimap projection ───────────────────────────────────────

static void terrain_cell(float height, float water_height, Cell *out) {
    out->bg = (RGB){0xf0, 0xee, 0xdc};
    if (height < water_height - 2) {
        strcpy(out->ch, "~"); out->fg = (RGB){0x22, 0x66, 0xaa};
    } else if (height < water_height) {
        strcpy(out->ch, "~"); out->fg = (RGB){0x44, 0x88, 0xbb};
    } else if (height < water_height + 1) {
        strcpy(out->ch, ","); out->fg = (RGB){0x99, 0x88, 0x66};
    } else if (height < water_height + 15) {
        strcpy(out->ch, "."); out->fg = (RGB){0x33, 0x66, 0x33};
    } else if (height < water_height + 40) {
        strcpy(out->ch, ":"); out->fg = (RGB){0x66, 0x66, 0x33};
    } else {
        strcpy(out->ch, "^"); out->fg = (RGB){0x66, 0x66, 0x66};
    }
}

static const char *yaw_to_dir_char(float yaw) {
    float deg = fmodf(yaw * 180.0f / (float)M_PI + 360.0f, 360.0f);
    if (deg >= 315 || deg < 45) return ">";
    if (deg >= 45 && deg < 135) return "^";
    if (deg >= 135 && deg < 225) return "<";
    return "v";
}

typedef struct {
    int col, row;
    int valid;
} GridPos;

static GridPos sim_to_grid_rotated(
    float sim_x, float sim_y,
    float self_x, float self_y,
    int cols, int rows,
    float mpc, float cos_y, float sin_y
) {
    float dx = sim_x - self_x;
    float dy = sim_y - self_y;
    float right = dx * sin_y - dy * cos_y;
    float fwd = dx * cos_y + dy * sin_y;
    int col = (int)(cols / 2.0f + right / mpc + 0.5f);
    int row = (int)(rows / 2.0f - fwd / mpc + 0.5f);
    GridPos p;
    p.col = col; p.row = row;
    p.valid = (col >= 0 && col < cols && row >= 0 && row < rows);
    return p;
}

GridFrame *project_minimap(
    TerrainFn terrain, void *ctx,
    const AvatarData *avatars, int nav,
    const ObjectData *objects, int nobj,
    int cols, int rows,
    float self_x, float self_y, float self_z,
    float water_height, float mpc,
    float yaw, bool flying __attribute__((unused))
) {
    GridFrame *f = grid_frame_create(cols, rows);
    float cos_y = cosf(yaw), sin_y = sinf(yaw);
    RGB bg = {0xf0, 0xee, 0xdc};

    // Terrain
    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            float sx = (c - cols / 2.0f) * mpc;
            float sy = (rows / 2.0f - r) * mpc;
            float sim_x = self_x + sx * sin_y + sy * cos_y;
            float sim_y = self_y - sx * cos_y + sy * sin_y;
            if (sim_x >= 0 && sim_x < 256 && sim_y >= 0 && sim_y < 256) {
                float h = terrain((int)sim_x, (int)sim_y, ctx);
                terrain_cell(h, water_height, &f->cells[r * cols + c]);
            } else {
                f->cells[r * cols + c] = (Cell){" ", {0x33, 0x33, 0x33}, bg};
            }
        }
    }

    // Objects
    for (int i = 0; i < nobj; i++) {
        const ObjectData *obj = &objects[i];
        float dz = fabsf(obj->z - self_z);
        if (dz >= 30) continue;
        float max_dim = obj->scale_x;
        if (obj->scale_y > max_dim) max_dim = obj->scale_y;
        if (obj->scale_z > max_dim) max_dim = obj->scale_z;
        if (max_dim < 0.5f) continue;

        GridPos pos = sim_to_grid_rotated(obj->x, obj->y, self_x, self_y, cols, rows, mpc, cos_y, sin_y);
        if (!pos.valid) continue;

        RGB fg = obj->is_tree ? (RGB){0x33, 0x66, 0x33} : (RGB){0x88, 0x55, 0x22};
        const char *ch = obj->is_tree ? "T" : "#";
        if (dz >= 10) fg = (RGB){0xcc, 0xcc, 0xcc};
        else if (dz >= 3) fg = (RGB){0x99, 0x99, 0x99};

        int idx = pos.row * cols + pos.col;
        strcpy(f->cells[idx].ch, ch);
        f->cells[idx].fg = fg;
    }

    // Avatars
    for (int i = 0; i < nav; i++) {
        const AvatarData *av = &avatars[i];
        if (av->is_self) continue;
        float dz = av->z - self_z;
        if (fabsf(dz) >= 30) continue;

        GridPos pos = sim_to_grid_rotated(av->x, av->y, self_x, self_y, cols, rows, mpc, cos_y, sin_y);
        if (!pos.valid) continue;

        const char *ch = yaw_to_dir_char(av->yaw);
        RGB fg = {0, 0, 0};
        if (fabsf(dz) >= 10) fg = (RGB){0xcc, 0xcc, 0xcc};
        else if (fabsf(dz) >= 3) fg = (RGB){0x99, 0x99, 0x99};

        int idx = pos.row * cols + pos.col;
        strcpy(f->cells[idx].ch, ch);
        f->cells[idx].fg = fg;

        // Altitude indicators
        if (dz > 5 && pos.row > 0) {
            int ai = (pos.row - 1) * cols + pos.col;
            strcpy(f->cells[ai].ch, "+");
            f->cells[ai].fg = fg;
        } else if (dz < -5 && pos.row < rows - 1) {
            int ai = (pos.row + 1) * cols + pos.col;
            strcpy(f->cells[ai].ch, "-");
            f->cells[ai].fg = fg;
        }
    }

    // Self at center
    int sc = cols / 2, sr = rows / 2;
    if (sc >= 0 && sc < cols && sr >= 0 && sr < rows) {
        int idx = sr * cols + sc;
        strcpy(f->cells[idx].ch, "@");
        f->cells[idx].fg = (RGB){0xcc, 0, 0};
    }

    // FOV arc
    for (int dr = -3; dr <= 3; dr++) {
        for (int dc = -3; dc <= 3; dc++) {
            if (dr == 0 && dc == 0) continue;
            int r = sr + dr, c = sc + dc;
            if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
            float dist = sqrtf(dc * dc + dr * dr);
            if (dist < 1.5f || dist > 3.5f) continue;
            float cell_angle = atan2f(-dr, dc);
            float diff = cell_angle - (float)(M_PI / 2.0); // always up in rotated map
            while (diff > M_PI) diff -= 2 * M_PI;
            while (diff < -M_PI) diff += 2 * M_PI;
            if (fabsf(diff) <= (float)(M_PI / 4.0)) {
                int idx = r * cols + c;
                char ch = f->cells[idx].ch[0];
                if (ch != '@' && ch != '^' && ch != 'v' && ch != '<' && ch != '>' &&
                    ch != '#' && ch != 'T' && ch != '+' && ch != '-') {
                    // Using middle dot (·) UTF-8: 0xC2 0xB7
                    f->cells[idx].ch[0] = '\xc2';
                    f->cells[idx].ch[1] = '\xb7';
                    f->cells[idx].ch[2] = '\0';
                    f->cells[idx].fg = (RGB){0xcc, 0, 0};
                }
            }
        }
    }

    // Compass labels
    struct { const char *label; float angle; } compass[] = {
        {"N", M_PI / 2}, {"E", 0}, {"S", -M_PI / 2}, {"W", M_PI},
    };
    for (int i = 0; i < 4; i++) {
        float dx = cosf(compass[i].angle);
        float dy = sinf(compass[i].angle);
        float rx = dx * sin_y - dy * cos_y;
        float ry = dx * cos_y + dy * sin_y;
        float half_c = cols / 2.0f - 1;
        float half_r = rows / 2.0f - 1;
        float t = 1e9f;
        if (rx != 0) { float tt = fabsf(half_c / rx); if (tt < t) t = tt; }
        if (ry != 0) { float tt = fabsf(half_r / ry); if (tt < t) t = tt; }
        int ec = (int)(cols / 2.0f + rx * t + 0.5f);
        int er = (int)(rows / 2.0f - ry * t + 0.5f);
        if (ec < 0) ec = 0; if (ec >= cols) ec = cols - 1;
        if (er < 0) er = 0; if (er >= rows) er = rows - 1;
        int idx = er * cols + ec;
        strcpy(f->cells[idx].ch, compass[i].label);
        f->cells[idx].fg = (RGB){0xff, 0xff, 0xff};
    }

    return f;
}
