// pixel_to_cells.c — Convert RGBA pixel buffer to Cell[]
// Uses chafa when available for high-quality unicode rendering (sextants, octants,
// wedges, braille, etc.), falls back to basic quadrant block chars.
#include "pixel_to_cells.h"
#include <string.h>
#include <stdlib.h>

#ifdef HAVE_CHAFA
#include <chafa.h>

GridFrame *pixels_to_cells(
    const uint8_t *pixels, int pw, int ph,
    uint8_t bg_r, uint8_t bg_g, uint8_t bg_b
) {
    int cols = (pw + 1) / 2;
    int rows = (ph + 1) / 2;

    // Configure chafa canvas
    ChafaSymbolMap *sym_map = chafa_symbol_map_new();
    chafa_symbol_map_add_by_tags(sym_map,
        CHAFA_SYMBOL_TAG_BLOCK | CHAFA_SYMBOL_TAG_BORDER |
        CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_SOLID |
        CHAFA_SYMBOL_TAG_QUAD | CHAFA_SYMBOL_TAG_HALF |
        CHAFA_SYMBOL_TAG_SEXTANT | CHAFA_SYMBOL_TAG_WEDGE |
        CHAFA_SYMBOL_TAG_DIAGONAL | CHAFA_SYMBOL_TAG_STIPPLE |
        CHAFA_SYMBOL_TAG_BRAILLE | CHAFA_SYMBOL_TAG_OCTANT);

    ChafaCanvasConfig *config = chafa_canvas_config_new();
    chafa_canvas_config_set_geometry(config, cols, rows);
    chafa_canvas_config_set_cell_geometry(config, 2, 2);
    chafa_canvas_config_set_canvas_mode(config, CHAFA_CANVAS_MODE_TRUECOLOR);
    chafa_canvas_config_set_symbol_map(config, sym_map);
    chafa_canvas_config_set_color_space(config, CHAFA_COLOR_SPACE_RGB);
    chafa_canvas_config_set_bg_color(config,
        ((guint32)bg_r << 16) | ((guint32)bg_g << 8) | bg_b);
    // Higher work factor = better quality symbol selection
    chafa_canvas_config_set_work_factor(config, 0.5f);

    ChafaCanvas *canvas = chafa_canvas_new(config);

    // Feed pixel data to chafa
    chafa_canvas_draw_all_pixels(canvas,
        CHAFA_PIXEL_RGBA8_UNASSOCIATED,
        pixels, pw, ph, pw * 4);

    // Extract per-cell character and colors into our GridFrame
    GridFrame *f = grid_frame_create(cols, rows);

    for (int row = 0; row < rows; row++) {
        for (int col = 0; col < cols; col++) {
            Cell *cell = &f->cells[row * cols + col];

            gunichar uc = chafa_canvas_get_char_at(canvas, col, row);

            // Encode gunichar as UTF-8
            if (uc < 0x80) {
                cell->ch[0] = (char)uc;
                cell->ch[1] = '\0';
            } else if (uc < 0x800) {
                cell->ch[0] = 0xC0 | (uc >> 6);
                cell->ch[1] = 0x80 | (uc & 0x3F);
                cell->ch[2] = '\0';
            } else if (uc < 0x10000) {
                cell->ch[0] = 0xE0 | (uc >> 12);
                cell->ch[1] = 0x80 | ((uc >> 6) & 0x3F);
                cell->ch[2] = 0x80 | (uc & 0x3F);
                cell->ch[3] = '\0';
            } else {
                cell->ch[0] = 0xF0 | (uc >> 18);
                cell->ch[1] = 0x80 | ((uc >> 12) & 0x3F);
                cell->ch[2] = 0x80 | ((uc >> 6) & 0x3F);
                cell->ch[3] = 0x80 | (uc & 0x3F);
                cell->ch[4] = '\0';
            }

            gint fg_packed, bg_packed;
            chafa_canvas_get_colors_at(canvas, col, row, &fg_packed, &bg_packed);

            cell->fg = (RGB){
                (fg_packed >> 16) & 0xFF,
                (fg_packed >> 8) & 0xFF,
                fg_packed & 0xFF
            };
            cell->bg = (RGB){
                (bg_packed >> 16) & 0xFF,
                (bg_packed >> 8) & 0xFF,
                bg_packed & 0xFF
            };
        }
    }

    chafa_canvas_unref(canvas);
    chafa_canvas_config_unref(config);
    chafa_symbol_map_unref(sym_map);

    return f;
}

#else
// ─── Fallback: quadrant block characters (no chafa) ───────────

// Unicode quadrant block characters indexed by 4-bit pattern.
// Bit 0 = top-left, bit 1 = top-right, bit 2 = bottom-left, bit 3 = bottom-right.
static const char *QUADRANT_CHARS[16] = {
    " ",            // 0b0000
    "\xe2\x96\x98", // 0b0001 ▘
    "\xe2\x96\x9d", // 0b0010 ▝
    "\xe2\x96\x80", // 0b0011 ▀
    "\xe2\x96\x96", // 0b0100 ▖
    "\xe2\x96\x8c", // 0b0101 ▌
    "\xe2\x96\x9e", // 0b0110 ▞
    "\xe2\x96\x9b", // 0b0111 ▛
    "\xe2\x96\x97", // 0b1000 ▗
    "\xe2\x96\x9a", // 0b1001 ▚
    "\xe2\x96\x90", // 0b1010 ▐
    "\xe2\x96\x9c", // 0b1011 ▜
    "\xe2\x96\x84", // 0b1100 ▄
    "\xe2\x96\x99", // 0b1101 ▙
    "\xe2\x96\x9f", // 0b1110 ▟
    "\xe2\x96\x88", // 0b1111 █
};

static int dist_sq(int r1, int g1, int b1, int r2, int g2, int b2) {
    int dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return dr * dr + dg * dg + db * db;
}

static int lum(int r, int g, int b) {
    return (299 * r + 587 * g + 114 * b) / 1000;
}

GridFrame *pixels_to_cells(
    const uint8_t *pixels, int pw, int ph,
    uint8_t bg_r, uint8_t bg_g, uint8_t bg_b
) {
    int cols = (pw + 1) / 2;
    int rows = (ph + 1) / 2;
    GridFrame *f = grid_frame_create(cols, rows);

    for (int cr = 0; cr < rows; cr++) {
        for (int cc = 0; cc < cols; cc++) {
            int px = cc * 2, py = cr * 2;
            // Gather 2x2 block
            int qr[4], qg[4], qb[4];
            for (int dy = 0; dy < 2; dy++) {
                for (int dx = 0; dx < 2; dx++) {
                    int x = px + dx, y = py + dy;
                    int qi = dy * 2 + dx;
                    if (x < pw && y < ph) {
                        int i = (y * pw + x) * 4;
                        if (pixels[i + 3] > 0) {
                            qr[qi] = pixels[i];
                            qg[qi] = pixels[i + 1];
                            qb[qi] = pixels[i + 2];
                        } else {
                            qr[qi] = bg_r; qg[qi] = bg_g; qb[qi] = bg_b;
                        }
                    } else {
                        qr[qi] = bg_r; qg[qi] = bg_g; qb[qi] = bg_b;
                    }
                }
            }

            // Find two most distant colors
            int max_d = -1, c1 = 0, c2 = 0;
            for (int i = 0; i < 4; i++) {
                for (int j = i + 1; j < 4; j++) {
                    int d = dist_sq(qr[i], qg[i], qb[i], qr[j], qg[j], qb[j]);
                    if (d > max_d) { max_d = d; c1 = i; c2 = j; }
                }
            }

            // Assign each pixel to nearer representative -> 4-bit pattern
            int pattern = 0;
            for (int i = 0; i < 4; i++) {
                int d1 = dist_sq(qr[i], qg[i], qb[i], qr[c1], qg[c1], qb[c1]);
                int d2 = dist_sq(qr[i], qg[i], qb[i], qr[c2], qg[c2], qb[c2]);
                if (d1 <= d2) pattern |= (1 << i);
            }

            // fg = darker, bg = lighter
            RGB fg_c, bg_c;
            if (lum(qr[c1], qg[c1], qb[c1]) <= lum(qr[c2], qg[c2], qb[c2])) {
                fg_c = (RGB){qr[c1], qg[c1], qb[c1]};
                bg_c = (RGB){qr[c2], qg[c2], qb[c2]};
            } else {
                fg_c = (RGB){qr[c2], qg[c2], qb[c2]};
                bg_c = (RGB){qr[c1], qg[c1], qb[c1]};
                pattern = (~pattern) & 0xF;
            }

            Cell *cell = &f->cells[cr * cols + cc];
            strncpy(cell->ch, QUADRANT_CHARS[pattern], sizeof(cell->ch) - 1);
            cell->ch[sizeof(cell->ch) - 1] = '\0';
            cell->fg = fg_c;
            cell->bg = bg_c;
        }
    }

    return f;
}

#endif // HAVE_CHAFA
