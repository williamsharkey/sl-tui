// color.c — RGB color utilities
#include "color.h"
#include <math.h>
#include <stdio.h>

// Terrain color stops: [height_offset_from_water, R, G, B]
static const struct { float h; uint8_t r, g, b; } TERRAIN_STOPS[] = {
    {-10, 0x10, 0x44, 0x88},
    { -5, 0x18, 0x55, 0x99},
    { -2, 0x22, 0x66, 0xaa},
    {  0, 0x44, 0x88, 0xbb},
    {0.3f, 0xaa, 0x99, 0x77},
    {1.5f, 0x99, 0x88, 0x66},
    {  3, 0x66, 0x88, 0x44},
    {  8, 0x33, 0x77, 0x33},
    { 15, 0x44, 0x66, 0x33},
    { 25, 0x55, 0x66, 0x33},
    { 35, 0x66, 0x66, 0x44},
    { 50, 0x77, 0x77, 0x55},
    { 70, 0x88, 0x88, 0x77},
    { 90, 0x77, 0x77, 0x77},
    {120, 0xaa, 0xaa, 0xaa},
};
#define NUM_STOPS (sizeof(TERRAIN_STOPS) / sizeof(TERRAIN_STOPS[0]))

static uint8_t lerp8(uint8_t a, uint8_t b, float t) {
    return (uint8_t)(a + (b - a) * t + 0.5f);
}

RGB terrain_rgb(float height, float water_height) {
    float h = height - water_height;
    if (h <= TERRAIN_STOPS[0].h)
        return (RGB){TERRAIN_STOPS[0].r, TERRAIN_STOPS[0].g, TERRAIN_STOPS[0].b};
    int last = NUM_STOPS - 1;
    if (h >= TERRAIN_STOPS[last].h)
        return (RGB){TERRAIN_STOPS[last].r, TERRAIN_STOPS[last].g, TERRAIN_STOPS[last].b};

    for (int i = 0; i < last; i++) {
        if (h >= TERRAIN_STOPS[i].h && h < TERRAIN_STOPS[i + 1].h) {
            float t = (h - TERRAIN_STOPS[i].h) / (TERRAIN_STOPS[i + 1].h - TERRAIN_STOPS[i].h);
            return (RGB){
                lerp8(TERRAIN_STOPS[i].r, TERRAIN_STOPS[i + 1].r, t),
                lerp8(TERRAIN_STOPS[i].g, TERRAIN_STOPS[i + 1].g, t),
                lerp8(TERRAIN_STOPS[i].b, TERRAIN_STOPS[i + 1].b, t),
            };
        }
    }
    return (RGB){TERRAIN_STOPS[last].r, TERRAIN_STOPS[last].g, TERRAIN_STOPS[last].b};
}

RGB water_pixel_rgb(float height, float water_height, float wx, float wy, float depth) {
    (void)depth;
    RGB base = terrain_rgb(height, water_height);
    float wave = sinf(wx * 0.8f + wy * 0.3f) * cosf(wy * 0.6f - wx * 0.2f);
    int hl = wave > 0.3f ? 30 : (wave < -0.3f ? -15 : 0);
    int r = base.r + hl, g = base.g + hl, b = base.b + hl;
    if (r < 0) r = 0; if (r > 255) r = 255;
    if (g < 0) g = 0; if (g > 255) g = 255;
    if (b < 0) b = 0; if (b > 255) b = 255;
    return (RGB){(uint8_t)r, (uint8_t)g, (uint8_t)b};
}

RGB fog_rgb(RGB c, float depth, float max_depth) {
    float t = depth / max_depth;
    if (t > 1.0f) t = 1.0f;
    return (RGB){
        (uint8_t)(c.r + (0x66 - c.r) * t + 0.5f),
        (uint8_t)(c.g + (0x77 - c.g) * t + 0.5f),
        (uint8_t)(c.b + (0x88 - c.b) * t + 0.5f),
    };
}

int color_dist_sq(RGB a, RGB b) {
    int dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return dr * dr + dg * dg + db * db;
}

int luminance(RGB c) {
    return (299 * c.r + 587 * c.g + 114 * c.b) / 1000;
}

int fg_color(char *buf, RGB c) {
    return sprintf(buf, "\x1b[38;2;%d;%d;%dm", c.r, c.g, c.b);
}

int bg_color(char *buf, RGB c) {
    return sprintf(buf, "\x1b[48;2;%d;%d;%dm", c.r, c.g, c.b);
}

void rgb_to_hex(char *buf, RGB c) {
    sprintf(buf, "#%02x%02x%02x", c.r, c.g, c.b);
}
