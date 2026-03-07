// ipc.h — JSON IPC with Node.js bridge subprocess
#ifndef IPC_H
#define IPC_H

#include "grid.h"
#include "cjson/cJSON.h"
#include <stdbool.h>

// Start the Node.js bridge subprocess
// Returns 0 on success, -1 on failure
int ipc_start(const char *bridge_script);

// Stop the bridge subprocess
void ipc_stop(void);

// Check if bridge is running
bool ipc_is_running(void);

// Check heartbeat and auto-restart if bridge died.
// Call from main loop. Returns true if bridge was restarted.
// If restarted with saved credentials, auto-re-login is attempted.
bool ipc_check_health(void);

// Send a command to the bridge (takes ownership of json)
void ipc_send(cJSON *json);

// Convenience senders
void ipc_send_login(const char *first, const char *last, const char *password);
void ipc_send_move(const char *dir);
void ipc_send_stop(void);
void ipc_send_turn(const char *direction); // "left" or "right"
void ipc_send_fly(bool enable);
void ipc_send_say(const char *msg);
void ipc_send_whisper(const char *msg);
void ipc_send_shout(const char *msg);
void ipc_send_im(const char *to, const char *msg);
void ipc_send_teleport(const char *region, int x, int y, int z);
void ipc_send_logout(void);

// Poll for incoming events (non-blocking)
// Returns a cJSON* event object, or NULL if none available.
// Caller must cJSON_Delete() the result.
cJSON *ipc_poll(void);

// Event types from bridge
typedef enum {
    EV_NONE,
    EV_LOGIN_OK,
    EV_LOGIN_FAIL,
    EV_STATE,        // position, avatars, objects, region
    EV_TERRAIN,      // 65536 height floats
    EV_CHAT,         // nearby chat message
    EV_IM,           // instant message
    EV_FRIEND_REQ,
    EV_FRIEND_ONLINE,
    EV_TP_OFFER,
    EV_DISCONNECTED,
    EV_HEARTBEAT,    // bridge alive ping
} EventType;

EventType ipc_event_type(const cJSON *ev);

// Store credentials for auto-reconnect
void ipc_set_reconnect_creds(const char *first, const char *last, const char *password);
void ipc_heartbeat_received(void);

#endif
