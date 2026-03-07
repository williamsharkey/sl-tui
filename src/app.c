// app.c — Main TUI application state machine
#include "app.h"
#include "terminal.h"
#include "input.h"
#include "renderer.h"
#include "ipc.h"
#include "cjson/cJSON.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <math.h>
#include <signal.h>
#include <time.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Terrain callback for grid functions
static float terrain_fn(int x, int y, void *ctx) {
    App *app = (App *)ctx;
    if (x < 0 || x >= 256 || y < 0 || y >= 256) return 0;
    return app->terrain[y * 256 + x];
}

void app_init(App *app) {
    memset(app, 0, sizeof(*app));
    app->mode = MODE_LOGIN;
    app->running = true;
    app->yaw = M_PI / 2; // face north
    app->water_height = 20;

    int cols, rows;
    term_get_size(&cols, &rows);
    app->layout = compute_layout(cols, rows);

    login_state_init(&app->login);
    chat_init(&app->chat);

    // Load saved credentials
    if (credentials_load(&app->saved_creds)) {
        app->has_saved_creds = true;
        strncpy(app->login.first_name, app->saved_creds.first_name, sizeof(app->login.first_name) - 1);
        strncpy(app->login.last_name, app->saved_creds.last_name, sizeof(app->login.last_name) - 1);
        strncpy(app->login.password, app->saved_creds.password, sizeof(app->login.password) - 1);
    }
}

void app_destroy(App *app) {
    grid_frame_destroy(app->prev_fp_frame);
    grid_frame_destroy(app->prev_minimap_frame);
    app->prev_fp_frame = NULL;
    app->prev_minimap_frame = NULL;
}

static void app_handle_login_key(App *app, KeyEvent ev) {
    switch (ev.type) {
        case KEY_RETURN:
            if (!app->login.first_name[0] || !app->login.password[0]) {
                strcpy(app->login.error, "First name and password required");
                login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
                return;
            }
            app->login_pending = true;
            login_render_loading(app->layout.total_cols, app->layout.total_rows, NULL);
            // Send login to bridge
            ipc_send_login(app->login.first_name,
                          app->login.last_name[0] ? app->login.last_name : "Resident",
                          app->login.password);
            break;
        case KEY_TAB:
            login_next_field(&app->login);
            login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
            break;
        case KEY_BACKSPACE:
            login_backspace(&app->login);
            login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
            break;
        case KEY_CHAR:
            login_append_char(&app->login, ev.ch);
            login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
            break;
        default:
            break;
    }
}

static void app_handle_grid_key(App *app, KeyEvent ev) {
    if (ev.type == KEY_CHAR) {
        switch (ev.ch) {
            case 'w': case 'W': ipc_send_move("forward"); app->stop_timer_ms = 200; break;
            case 's': case 'S': ipc_send_move("back"); app->stop_timer_ms = 200; break;
            case 'a': case 'A': ipc_send_move("strafe_left"); app->stop_timer_ms = 200; break;
            case 'd': case 'D': ipc_send_move("strafe_right"); app->stop_timer_ms = 200; break;
            case ' ': ipc_send_move("up"); app->stop_timer_ms = 200; break;
            case 'f': case 'F':
                app->flying = !app->flying;
                ipc_send_fly(app->flying);
                break;
            case 'v': case 'V':
                app->dither_enabled = !app->dither_enabled;
                if (!app->dither_enabled) app->dither_phase = 0;
                chat_add_system(&app->chat, app->dither_enabled ? "Dither ON" : "Dither OFF");
                break;
            case 'q': case 'Q':
                app->running = false;
                break;
        }
    } else {
        switch (ev.type) {
            case KEY_UP: ipc_send_move("forward"); app->stop_timer_ms = 200; break;
            case KEY_DOWN: ipc_send_move("back"); app->stop_timer_ms = 200; break;
            case KEY_LEFT: ipc_send_turn("left"); break;
            case KEY_RIGHT: ipc_send_turn("right"); break;
            case KEY_RETURN:
                app->mode = MODE_CHAT_INPUT;
                app->chat_input[0] = '\0';
                app->chat_input_len = 0;
                term_show_cursor();
                break;
            default: break;
        }
    }
}

static void app_handle_chat_key(App *app, KeyEvent ev) {
    switch (ev.type) {
        case KEY_ESCAPE:
            app->mode = MODE_GRID;
            app->chat_input[0] = '\0';
            app->chat_input_len = 0;
            term_hide_cursor();
            break;
        case KEY_RETURN:
            if (app->chat_input_len > 0) {
                // Handle commands
                if (strncmp(app->chat_input, "/tp ", 4) == 0) {
                    char region[256] = {0};
                    int x = 128, y = 128, z = 30;
                    sscanf(app->chat_input + 4, "%255s %d %d %d", region, &x, &y, &z);
                    if (region[0]) {
                        char msg[512];
                        snprintf(msg, sizeof(msg), "Teleporting to %s...", region);
                        chat_add_system(&app->chat, msg);
                        ipc_send_teleport(region, x, y, z);
                    }
                } else if (strncmp(app->chat_input, "/im ", 4) == 0) {
                    char uuid[64] = {0}, msg[512] = {0};
                    if (sscanf(app->chat_input + 4, "%63s %511[^\n]", uuid, msg) == 2) {
                        ipc_send_im(uuid, msg);
                        char sys[512];
                        snprintf(sys, sizeof(sys), "IM sent to %s", uuid);
                        chat_add_system(&app->chat, sys);
                    } else {
                        chat_add_system(&app->chat, "Usage: /im <uuid> <message>");
                    }
                } else if (strcmp(app->chat_input, "/logout") == 0) {
                    ipc_send_logout();
                    app->mode = MODE_LOGIN;
                    login_state_init(&app->login);
                    term_show_cursor();
                    login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
                    return;
                } else if (strncmp(app->chat_input, "/shout ", 7) == 0) {
                    ipc_send_shout(app->chat_input + 7);
                } else if (strncmp(app->chat_input, "/whisper ", 9) == 0) {
                    ipc_send_whisper(app->chat_input + 9);
                } else {
                    ipc_send_say(app->chat_input);
                }
            }
            app->mode = MODE_GRID;
            app->chat_input[0] = '\0';
            app->chat_input_len = 0;
            term_hide_cursor();
            break;
        case KEY_BACKSPACE:
            if (app->chat_input_len > 0) {
                app->chat_input[--app->chat_input_len] = '\0';
            }
            break;
        case KEY_CHAR:
            if (app->chat_input_len < (int)sizeof(app->chat_input) - 1) {
                app->chat_input[app->chat_input_len++] = ev.ch;
                app->chat_input[app->chat_input_len] = '\0';
            }
            break;
        default:
            break;
    }
}

static void app_process_event(App *app, cJSON *ev) {
    EventType type = ipc_event_type(ev);

    switch (type) {
        case EV_LOGIN_OK: {
            const cJSON *region = cJSON_GetObjectItem(ev, "region");
            if (region && cJSON_IsString(region))
                strncpy(app->region_name, region->valuestring, sizeof(app->region_name) - 1);
            const cJSON *wh = cJSON_GetObjectItem(ev, "waterHeight");
            if (wh && cJSON_IsNumber(wh))
                app->water_height = (float)wh->valuedouble;

            app->login_pending = false;
            app->mode = MODE_GRID;
            term_hide_cursor();

            // Save credentials + store for auto-reconnect
            Credentials c;
            strncpy(c.first_name, app->login.first_name, sizeof(c.first_name) - 1);
            strncpy(c.last_name, app->login.last_name, sizeof(c.last_name) - 1);
            strncpy(c.password, app->login.password, sizeof(c.password) - 1);
            credentials_save(&c);
            ipc_set_reconnect_creds(app->login.first_name,
                app->login.last_name[0] ? app->login.last_name : "Resident",
                app->login.password);

            // Full initial render
            term_buf_clear();
            term_clear_screen();
            render_separator(&app->layout);
            term_buf_flush();
            break;
        }

        case EV_LOGIN_FAIL: {
            app->login_pending = false;
            const cJSON *err = cJSON_GetObjectItem(ev, "error");
            snprintf(app->login.error, sizeof(app->login.error), "Login failed: %s",
                     err && cJSON_IsString(err) ? err->valuestring : "unknown");
            login_render(&app->login, app->layout.total_cols, app->layout.total_rows);
            break;
        }

        case EV_STATE: {
            // Position
            const cJSON *pos = cJSON_GetObjectItem(ev, "pos");
            if (pos && cJSON_IsArray(pos) && cJSON_GetArraySize(pos) >= 3) {
                app->self_x = (float)cJSON_GetArrayItem(pos, 0)->valuedouble;
                app->self_y = (float)cJSON_GetArrayItem(pos, 1)->valuedouble;
                app->self_z = (float)cJSON_GetArrayItem(pos, 2)->valuedouble;
            }

            // Yaw
            const cJSON *yaw = cJSON_GetObjectItem(ev, "yaw");
            if (yaw && cJSON_IsNumber(yaw))
                app->yaw = (float)yaw->valuedouble;

            // Flying
            const cJSON *fly = cJSON_GetObjectItem(ev, "flying");
            if (fly) app->flying = cJSON_IsTrue(fly);

            // Region
            const cJSON *region = cJSON_GetObjectItem(ev, "region");
            if (region && cJSON_IsString(region))
                strncpy(app->region_name, region->valuestring, sizeof(app->region_name) - 1);

            // Avatars
            const cJSON *avs = cJSON_GetObjectItem(ev, "avatars");
            if (avs && cJSON_IsArray(avs)) {
                app->nav = 0;
                cJSON *a;
                cJSON_ArrayForEach(a, avs) {
                    if (app->nav >= 256) break;
                    AvatarData *ad = &app->avatars[app->nav];
                    memset(ad, 0, sizeof(*ad));
                    const cJSON *p = cJSON_GetObjectItem(a, "pos");
                    if (p && cJSON_IsArray(p) && cJSON_GetArraySize(p) >= 3) {
                        ad->x = (float)cJSON_GetArrayItem(p, 0)->valuedouble;
                        ad->y = (float)cJSON_GetArrayItem(p, 1)->valuedouble;
                        ad->z = (float)cJSON_GetArrayItem(p, 2)->valuedouble;
                    }
                    const cJSON *y = cJSON_GetObjectItem(a, "yaw");
                    if (y) ad->yaw = (float)y->valuedouble;
                    const cJSON *self = cJSON_GetObjectItem(a, "isSelf");
                    ad->is_self = self && cJSON_IsTrue(self);
                    const cJSON *uuid = cJSON_GetObjectItem(a, "uuid");
                    if (uuid && cJSON_IsString(uuid))
                        strncpy(ad->uuid, uuid->valuestring, sizeof(ad->uuid) - 1);
                    const cJSON *fn = cJSON_GetObjectItem(a, "firstName");
                    if (fn && cJSON_IsString(fn))
                        strncpy(ad->first_name, fn->valuestring, sizeof(ad->first_name) - 1);
                    const cJSON *ln = cJSON_GetObjectItem(a, "lastName");
                    if (ln && cJSON_IsString(ln))
                        strncpy(ad->last_name, ln->valuestring, sizeof(ad->last_name) - 1);
                    app->nav++;
                }
            }

            // Objects
            const cJSON *objs = cJSON_GetObjectItem(ev, "objects");
            if (objs && cJSON_IsArray(objs)) {
                app->nobj = 0;
                cJSON *o;
                cJSON_ArrayForEach(o, objs) {
                    if (app->nobj >= 4096) break;
                    ObjectData *od = &app->objects[app->nobj];
                    memset(od, 0, sizeof(*od));
                    const cJSON *p = cJSON_GetObjectItem(o, "pos");
                    if (p && cJSON_IsArray(p) && cJSON_GetArraySize(p) >= 3) {
                        od->x = (float)cJSON_GetArrayItem(p, 0)->valuedouble;
                        od->y = (float)cJSON_GetArrayItem(p, 1)->valuedouble;
                        od->z = (float)cJSON_GetArrayItem(p, 2)->valuedouble;
                    }
                    const cJSON *sc = cJSON_GetObjectItem(o, "scale");
                    if (sc && cJSON_IsArray(sc) && cJSON_GetArraySize(sc) >= 3) {
                        od->scale_x = (float)cJSON_GetArrayItem(sc, 0)->valuedouble;
                        od->scale_y = (float)cJSON_GetArrayItem(sc, 1)->valuedouble;
                        od->scale_z = (float)cJSON_GetArrayItem(sc, 2)->valuedouble;
                    }
                    const cJSON *tree = cJSON_GetObjectItem(o, "isTree");
                    od->is_tree = tree && cJSON_IsTrue(tree);
                    const cJSON *uuid = cJSON_GetObjectItem(o, "uuid");
                    if (uuid && cJSON_IsString(uuid))
                        strncpy(od->uuid, uuid->valuestring, sizeof(od->uuid) - 1);
                    app->nobj++;
                }
            }
            break;
        }

        case EV_TERRAIN: {
            const cJSON *heights = cJSON_GetObjectItem(ev, "heights");
            if (heights && cJSON_IsArray(heights)) {
                int n = cJSON_GetArraySize(heights);
                if (n > 256 * 256) n = 256 * 256;
                for (int i = 0; i < n; i++) {
                    app->terrain[i] = (float)cJSON_GetArrayItem(heights, i)->valuedouble;
                }
                app->terrain_loaded = true;
            }
            break;
        }

        case EV_CHAT: {
            const cJSON *from = cJSON_GetObjectItem(ev, "from");
            const cJSON *msg = cJSON_GetObjectItem(ev, "msg");
            if (from && msg && cJSON_IsString(from) && cJSON_IsString(msg))
                chat_add(&app->chat, from->valuestring, msg->valuestring);
            break;
        }

        case EV_IM: {
            const cJSON *from = cJSON_GetObjectItem(ev, "fromName");
            const cJSON *msg = cJSON_GetObjectItem(ev, "msg");
            if (from && msg && cJSON_IsString(from) && cJSON_IsString(msg)) {
                char label[256];
                snprintf(label, sizeof(label), "[IM] %s", from->valuestring);
                chat_add(&app->chat, label, msg->valuestring);
            }
            break;
        }

        case EV_FRIEND_REQ: {
            const cJSON *from = cJSON_GetObjectItem(ev, "fromName");
            const cJSON *msg = cJSON_GetObjectItem(ev, "msg");
            char line[512];
            snprintf(line, sizeof(line), "Friend request from %s: %s",
                     from && cJSON_IsString(from) ? from->valuestring : "?",
                     msg && cJSON_IsString(msg) ? msg->valuestring : "");
            chat_add_system(&app->chat, line);
            break;
        }

        case EV_FRIEND_ONLINE: {
            const cJSON *name = cJSON_GetObjectItem(ev, "name");
            const cJSON *online = cJSON_GetObjectItem(ev, "online");
            char line[256];
            snprintf(line, sizeof(line), "%s is now %s",
                     name && cJSON_IsString(name) ? name->valuestring : "?",
                     online && cJSON_IsTrue(online) ? "online" : "offline");
            chat_add_system(&app->chat, line);
            break;
        }

        case EV_DISCONNECTED: {
            const cJSON *reason = cJSON_GetObjectItem(ev, "reason");
            char line[256];
            snprintf(line, sizeof(line), "Disconnected: %s",
                     reason && cJSON_IsString(reason) ? reason->valuestring : "unknown");
            chat_add_system(&app->chat, line);
            break;
        }

        case EV_HEARTBEAT:
            ipc_heartbeat_received();
            break;

        default:
            break;
    }
}

static void app_tick(App *app) {
    if (app->mode != MODE_GRID && app->mode != MODE_CHAT_INPUT) return;
    if (!app->terrain_loaded) return;

    // Advance dither
    if (app->dither_enabled) app->dither_phase += 0.15f;

    term_buf_clear();

    // FP view
    if (app->layout.fp_rows > 0) {
        GridFrame *fp = project_first_person(
            terrain_fn, app,
            app->avatars, app->nav,
            app->objects, app->nobj,
            app->self_x, app->self_y, app->self_z,
            app->yaw, app->water_height,
            app->layout.fp_cols, app->layout.fp_rows,
            app->dither_enabled ? app->dither_phase : 0
        );

        if (app->prev_fp_frame) {
            int count = 0;
            CellDelta *deltas = grid_diff_frames(app->prev_fp_frame, fp, &count);
            if (count > 0) {
                render_fp_delta(&app->layout, deltas, count);
                free(deltas);
            }
        } else {
            render_fp_view(&app->layout, fp);
        }

        grid_frame_destroy(app->prev_fp_frame);
        app->prev_fp_frame = fp;
    }

    // Minimap
    float mpc = 256.0f / app->layout.minimap_cols;
    GridFrame *mm = project_minimap(
        terrain_fn, app,
        app->avatars, app->nav,
        app->objects, app->nobj,
        app->layout.minimap_cols, app->layout.minimap_rows,
        app->self_x, app->self_y, app->self_z,
        app->water_height, mpc,
        app->yaw, app->flying
    );

    // Always re-render minimap fully (opaque background, no ghosting)
    render_minimap(&app->layout, mm);
    grid_frame_destroy(app->prev_minimap_frame);
    app->prev_minimap_frame = mm;

    // Status bar
    render_status_bar(&app->layout, app->region_name,
                      app->self_x, app->self_y, app->self_z, app->flying);

    // Chat
    const char *chat_lines[32];
    int nchat = chat_get_visible(&app->chat, chat_lines, app->layout.chat_lines);
    render_chat_lines(&app->layout, chat_lines, nchat);

    // Input bar
    const char *mode_str = app->mode == MODE_CHAT_INPUT ? "chat-input" : "grid";
    render_input_line(&app->layout, mode_str, app->chat_input);

    term_buf_flush();
}

static uint64_t time_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void app_run(App *app) {
    term_enter_alt_screen();
    term_enable_raw_mode();

    // Start bridge subprocess
    if (ipc_start("bridge/bridge.ts") != 0) {
        term_disable_raw_mode();
        term_exit_alt_screen();
        fprintf(stderr, "Failed to start bridge subprocess\n");
        return;
    }

    // Show login screen
    login_render(&app->login, app->layout.total_cols, app->layout.total_rows);

    uint64_t last_tick = time_ms();
    uint64_t last_stop_check = time_ms();

    while (app->running) {
        // Handle input (non-blocking)
        KeyEvent ev = input_read_key();
        if (ev.type == KEY_CTRL_C) {
            app->running = false;
            break;
        }

        if (ev.type != KEY_NONE) {
            switch (app->mode) {
                case MODE_LOGIN: app_handle_login_key(app, ev); break;
                case MODE_GRID: app_handle_grid_key(app, ev); break;
                case MODE_CHAT_INPUT: app_handle_chat_key(app, ev); break;
            }
        }

        // Process bridge events
        cJSON *bridge_ev;
        while ((bridge_ev = ipc_poll()) != NULL) {
            app_process_event(app, bridge_ev);
            cJSON_Delete(bridge_ev);
        }

        // Check bridge health — auto-restart if dead
        if (ipc_check_health()) {
            chat_add_system(&app->chat, "Bridge restarted, reconnecting...");
            app->login_pending = true;
        }

        // Movement stop timer
        uint64_t now = time_ms();
        if (app->stop_timer_ms > 0) {
            if ((int)(now - last_stop_check) >= app->stop_timer_ms) {
                ipc_send_stop();
                app->stop_timer_ms = 0;
            }
        }
        if (ev.type != KEY_NONE) last_stop_check = now;

        // Tick at ~15Hz
        if (now - last_tick >= 66) {
            app_tick(app);
            last_tick = now;

            // Resize check
            int cols, rows;
            term_get_size(&cols, &rows);
            if (cols != app->layout.total_cols || rows != app->layout.total_rows) {
                app->layout = compute_layout(cols, rows);
                grid_frame_destroy(app->prev_fp_frame);
                grid_frame_destroy(app->prev_minimap_frame);
                app->prev_fp_frame = NULL;
                app->prev_minimap_frame = NULL;
            }
        }

        // Sleep ~2ms to avoid busy-waiting
        usleep(2000);
    }

    // Cleanup
    ipc_stop();
    term_disable_raw_mode();
    term_exit_alt_screen();
}
