// color.h — RGB color utilities, truecolor escape sequences
#ifndef COLOR_H
#define COLOR_H

#include <stdint.h>

typedef struct { uint8_t r, g, b; } RGB;

// Terrain color: smooth gradient interpolation by height relative to water
RGB terrain_rgb(float height, float water_height);

// Water surface with wavelet pattern
RGB water_pixel_rgb(float height, float water_height, float wx, float wy, float depth);

// Apply depth fog to color
RGB fog_rgb(RGB c, float depth, float max_depth);

// Color distance squared (for quantization)
int color_dist_sq(RGB a, RGB b);

// Luminance (perceptual)
int luminance(RGB c);

// Format RGB as truecolor fg/bg escape sequence into buf
// Returns number of bytes written
int fg_color(char *buf, RGB c);
int bg_color(char *buf, RGB c);

// RGB to hex string "#rrggbb"
void rgb_to_hex(char *buf, RGB c);

#endif
