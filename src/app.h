// app.h — Main TUI application state machine
#ifndef APP_H
#define APP_H

#include "screen.h"
#include "grid.h"
#include "chat.h"
#include "login.h"
#include "credentials.h"
#include <stdbool.h>

typedef enum {
    MODE_LOGIN,
    MODE_GRID,
    MODE_CHAT_INPUT,
} AppMode;

typedef struct {
    AppMode mode;
    ScreenLayout layout;
    LoginState login;
    ChatBuffer chat;
    char chat_input[512];
    int chat_input_len;
    char region_name[256];
    bool flying;
    bool dither_enabled;
    float dither_phase;
    bool running;
    bool login_pending;

    // Position from bridge
    float self_x, self_y, self_z;
    float yaw;
    float water_height;

    // Terrain cache (from bridge)
    float terrain[256 * 256];
    bool terrain_loaded;

    // Avatar/object data (from bridge state updates)
    AvatarData avatars[256];
    int nav;
    ObjectData objects[4096];
    int nobj;

    // Previous frames for delta rendering
    GridFrame *prev_fp_frame;
    GridFrame *prev_minimap_frame;

    // Saved credentials
    Credentials saved_creds;
    bool has_saved_creds;

    // Movement stop timer
    int stop_timer_ms;
} App;

void app_init(App *app);
void app_destroy(App *app);

// Main loop — blocks until quit
void app_run(App *app);

#endif
