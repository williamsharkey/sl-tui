// chat.h — Chat message ring buffer
#ifndef CHAT_H
#define CHAT_H

#define CHAT_MAX_MESSAGES 200
#define CHAT_MAX_LINE_LEN 512

typedef struct {
    char messages[CHAT_MAX_MESSAGES][CHAT_MAX_LINE_LEN];
    int count;       // total messages stored
    int head;        // next write position (ring)
    int scroll_offset;
} ChatBuffer;

void chat_init(ChatBuffer *cb);
void chat_add(ChatBuffer *cb, const char *from, const char *message);
void chat_add_system(ChatBuffer *cb, const char *message);

// Get visible lines for rendering. Returns pointers into the buffer.
// lines[] must have space for at least `count` pointers.
// Returns actual number of lines written.
int chat_get_visible(const ChatBuffer *cb, const char **lines, int count);

void chat_scroll_up(ChatBuffer *cb, int n);
void chat_scroll_down(ChatBuffer *cb, int n);

#endif
