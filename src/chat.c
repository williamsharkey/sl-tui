// chat.c — Chat message ring buffer
#include "chat.h"
#include <string.h>
#include <stdio.h>

void chat_init(ChatBuffer *cb) {
    memset(cb, 0, sizeof(*cb));
}

static void chat_push(ChatBuffer *cb, const char *line) {
    int idx = cb->head % CHAT_MAX_MESSAGES;
    snprintf(cb->messages[idx], CHAT_MAX_LINE_LEN, "%s", line);
    cb->head++;
    if (cb->count < CHAT_MAX_MESSAGES) cb->count++;
    cb->scroll_offset = 0; // auto-scroll to bottom
}

void chat_add(ChatBuffer *cb, const char *from, const char *message) {
    char line[CHAT_MAX_LINE_LEN];
    snprintf(line, sizeof(line), "%s: %s", from, message);
    chat_push(cb, line);
}

void chat_add_system(ChatBuffer *cb, const char *message) {
    char line[CHAT_MAX_LINE_LEN];
    snprintf(line, sizeof(line), "* %s", message);
    chat_push(cb, line);
}

int chat_get_visible(const ChatBuffer *cb, const char **lines, int count) {
    int total = cb->count;
    int end = total - cb->scroll_offset;
    if (end < 0) end = 0;
    int start = end - count;
    if (start < 0) start = 0;

    int n = 0;
    for (int i = start; i < end && n < count; i++) {
        // Calculate ring index
        int base = cb->head - cb->count; // oldest message
        int ring_idx = (base + i) % CHAT_MAX_MESSAGES;
        if (ring_idx < 0) ring_idx += CHAT_MAX_MESSAGES;
        lines[n++] = cb->messages[ring_idx];
    }
    return n;
}

void chat_scroll_up(ChatBuffer *cb, int n) {
    cb->scroll_offset += n;
    if (cb->scroll_offset > cb->count - 1)
        cb->scroll_offset = cb->count - 1;
    if (cb->scroll_offset < 0) cb->scroll_offset = 0;
}

void chat_scroll_down(ChatBuffer *cb, int n) {
    cb->scroll_offset -= n;
    if (cb->scroll_offset < 0) cb->scroll_offset = 0;
}
