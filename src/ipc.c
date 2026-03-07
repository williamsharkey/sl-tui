// ipc.c — JSON IPC with Node.js bridge subprocess
#define _DARWIN_C_SOURCE
#include "ipc.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <sys/wait.h>
#include <time.h>

static pid_t bridge_pid = -1;
static int to_bridge_fd = -1;    // write end → bridge stdin
static int from_bridge_fd = -1;  // read end ← bridge stdout

// Line buffer for reading from bridge
#define LINE_BUF_SIZE (2 * 1024 * 1024) // 2MB for terrain data (~700KB)
static char line_buf[LINE_BUF_SIZE];
static int line_buf_len = 0;

// Heartbeat / auto-restart state
static char bridge_script_path[512] = {0};
static uint64_t last_heartbeat_ms = 0;
static int restart_count = 0;
#define HEARTBEAT_TIMEOUT_MS 8000
#define MAX_RESTARTS 5

// Reconnect credentials
static char reconn_first[128] = {0};
static char reconn_last[128] = {0};
static char reconn_pass[128] = {0};
static bool has_reconn_creds = false;

static uint64_t ipc_time_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int ipc_start(const char *bridge_script) {
    // Save script path for restarts
    strncpy(bridge_script_path, bridge_script, sizeof(bridge_script_path) - 1);

    int pipe_to[2], pipe_from[2];
    if (pipe(pipe_to) < 0 || pipe(pipe_from) < 0) return -1;

    pid_t pid = fork();
    if (pid < 0) return -1;

    if (pid == 0) {
        // Child: bridge subprocess
        close(pipe_to[1]);
        close(pipe_from[0]);
        dup2(pipe_to[0], STDIN_FILENO);
        dup2(pipe_from[1], STDOUT_FILENO);
        close(pipe_to[0]);
        close(pipe_from[1]);

        // Run via tsx (TypeScript execution)
        execlp("npx", "npx", "tsx", bridge_script, (char *)NULL);
        // If exec fails
        _exit(127);
    }

    // Parent
    close(pipe_to[0]);
    close(pipe_from[1]);
    to_bridge_fd = pipe_to[1];
    from_bridge_fd = pipe_from[0];
    bridge_pid = pid;
    line_buf_len = 0;

    // Set from_bridge_fd to non-blocking
    int flags = fcntl(from_bridge_fd, F_GETFL, 0);
    fcntl(from_bridge_fd, F_SETFL, flags | O_NONBLOCK);

    last_heartbeat_ms = ipc_time_ms();
    return 0;
}

void ipc_stop(void) {
    if (bridge_pid > 0) {
        // Send quit command
        cJSON *quit = cJSON_CreateObject();
        cJSON_AddStringToObject(quit, "cmd", "quit");
        ipc_send(quit);

        // Give it a moment then kill
        usleep(200000); // 200ms
        kill(bridge_pid, SIGTERM);
        waitpid(bridge_pid, NULL, WNOHANG);
        bridge_pid = -1;
    }
    if (to_bridge_fd >= 0) { close(to_bridge_fd); to_bridge_fd = -1; }
    if (from_bridge_fd >= 0) { close(from_bridge_fd); from_bridge_fd = -1; }
}

bool ipc_is_running(void) {
    if (bridge_pid <= 0) return false;
    int status;
    pid_t result = waitpid(bridge_pid, &status, WNOHANG);
    if (result == bridge_pid) {
        bridge_pid = -1;
        return false;
    }
    return true;
}

void ipc_send(cJSON *json) {
    if (to_bridge_fd < 0) { cJSON_Delete(json); return; }
    char *str = cJSON_PrintUnformatted(json);
    if (str) {
        size_t len = strlen(str);
        // Write JSON + newline
        write(to_bridge_fd, str, len);
        write(to_bridge_fd, "\n", 1);
        free(str);
    }
    cJSON_Delete(json);
}

void ipc_send_login(const char *first, const char *last, const char *password) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "login");
    cJSON_AddStringToObject(j, "firstName", first);
    cJSON_AddStringToObject(j, "lastName", last);
    cJSON_AddStringToObject(j, "password", password);
    ipc_send(j);
}

void ipc_send_move(const char *dir) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "move");
    cJSON_AddStringToObject(j, "dir", dir);
    ipc_send(j);
}

void ipc_send_stop(void) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "stop");
    ipc_send(j);
}

void ipc_send_turn(const char *direction) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "turn");
    cJSON_AddStringToObject(j, "dir", direction);
    ipc_send(j);
}

void ipc_send_fly(bool enable) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "fly");
    cJSON_AddBoolToObject(j, "enable", enable);
    ipc_send(j);
}

void ipc_send_say(const char *msg) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "say");
    cJSON_AddStringToObject(j, "msg", msg);
    ipc_send(j);
}

void ipc_send_whisper(const char *msg) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "whisper");
    cJSON_AddStringToObject(j, "msg", msg);
    ipc_send(j);
}

void ipc_send_shout(const char *msg) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "shout");
    cJSON_AddStringToObject(j, "msg", msg);
    ipc_send(j);
}

void ipc_send_im(const char *to, const char *msg) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "im");
    cJSON_AddStringToObject(j, "to", to);
    cJSON_AddStringToObject(j, "msg", msg);
    ipc_send(j);
}

void ipc_send_teleport(const char *region, int x, int y, int z) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "teleport");
    cJSON_AddStringToObject(j, "region", region);
    cJSON_AddNumberToObject(j, "x", x);
    cJSON_AddNumberToObject(j, "y", y);
    cJSON_AddNumberToObject(j, "z", z);
    ipc_send(j);
}

void ipc_send_logout(void) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "cmd", "logout");
    ipc_send(j);
}

cJSON *ipc_poll(void) {
    if (from_bridge_fd < 0) return NULL;

    // Read available data
    while (1) {
        int avail = LINE_BUF_SIZE - line_buf_len - 1;
        if (avail <= 0) break;
        ssize_t n = read(from_bridge_fd, line_buf + line_buf_len, avail);
        if (n <= 0) break; // EAGAIN or EOF
        line_buf_len += n;
    }

    // Find a complete line (newline-delimited JSON)
    char *nl = memchr(line_buf, '\n', line_buf_len);
    if (!nl) return NULL;

    int line_len = nl - line_buf;
    line_buf[line_len] = '\0';

    cJSON *json = cJSON_Parse(line_buf);

    // Shift remaining data
    int remaining = line_buf_len - line_len - 1;
    if (remaining > 0)
        memmove(line_buf, nl + 1, remaining);
    line_buf_len = remaining;

    return json; // may be NULL if parse failed
}

EventType ipc_event_type(const cJSON *ev) {
    const cJSON *type = cJSON_GetObjectItem(ev, "ev");
    if (!type || !cJSON_IsString(type)) return EV_NONE;
    const char *s = type->valuestring;

    if (strcmp(s, "login_ok") == 0) return EV_LOGIN_OK;
    if (strcmp(s, "login_fail") == 0) return EV_LOGIN_FAIL;
    if (strcmp(s, "state") == 0) return EV_STATE;
    if (strcmp(s, "terrain") == 0) return EV_TERRAIN;
    if (strcmp(s, "chat") == 0) return EV_CHAT;
    if (strcmp(s, "im") == 0) return EV_IM;
    if (strcmp(s, "friend_req") == 0) return EV_FRIEND_REQ;
    if (strcmp(s, "friend_online") == 0) return EV_FRIEND_ONLINE;
    if (strcmp(s, "tp_offer") == 0) return EV_TP_OFFER;
    if (strcmp(s, "disconnected") == 0) return EV_DISCONNECTED;
    if (strcmp(s, "heartbeat") == 0) return EV_HEARTBEAT;
    return EV_NONE;
}

void ipc_set_reconnect_creds(const char *first, const char *last, const char *password) {
    strncpy(reconn_first, first, sizeof(reconn_first) - 1);
    strncpy(reconn_last, last, sizeof(reconn_last) - 1);
    strncpy(reconn_pass, password, sizeof(reconn_pass) - 1);
    has_reconn_creds = true;
}

bool ipc_check_health(void) {
    if (bridge_pid <= 0) return false;

    // Check if process is still alive
    bool alive = ipc_is_running();

    if (!alive) {
        if (restart_count >= MAX_RESTARTS) return false;
        restart_count++;

        // Clean up old fds
        if (to_bridge_fd >= 0) { close(to_bridge_fd); to_bridge_fd = -1; }
        if (from_bridge_fd >= 0) { close(from_bridge_fd); from_bridge_fd = -1; }

        // Restart
        if (ipc_start(bridge_script_path) != 0) return false;

        // Auto re-login if we have credentials
        if (has_reconn_creds) {
            ipc_send_login(reconn_first, reconn_last, reconn_pass);
        }
        return true;
    }

    // Check heartbeat timeout
    uint64_t now = ipc_time_ms();
    if (last_heartbeat_ms > 0 && (now - last_heartbeat_ms) > HEARTBEAT_TIMEOUT_MS) {
        // Bridge is hung — kill and restart
        kill(bridge_pid, SIGKILL);
        waitpid(bridge_pid, NULL, 0);
        bridge_pid = -1;

        if (restart_count >= MAX_RESTARTS) return false;
        restart_count++;

        if (to_bridge_fd >= 0) { close(to_bridge_fd); to_bridge_fd = -1; }
        if (from_bridge_fd >= 0) { close(from_bridge_fd); from_bridge_fd = -1; }

        if (ipc_start(bridge_script_path) != 0) return false;
        if (has_reconn_creds) {
            ipc_send_login(reconn_first, reconn_last, reconn_pass);
        }
        return true;
    }

    return false;
}

void ipc_heartbeat_received(void) {
    last_heartbeat_ms = ipc_time_ms();
    restart_count = 0; // reset on successful heartbeat
}
