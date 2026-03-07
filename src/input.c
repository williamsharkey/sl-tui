// input.c — Raw stdin keypress reading
#include "input.h"
#include <unistd.h>
#include <string.h>

KeyEvent input_read_key(void) {
    KeyEvent ev = {KEY_NONE, 0};
    char buf[8];
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) return ev;

    if (n == 1) {
        unsigned char c = (unsigned char)buf[0];
        if (c == 3) { ev.type = KEY_CTRL_C; return ev; }
        if (c == 13 || c == 10) { ev.type = KEY_RETURN; return ev; }
        if (c == 127 || c == 8) { ev.type = KEY_BACKSPACE; return ev; }
        if (c == 9) { ev.type = KEY_TAB; return ev; }
        if (c == 27) { ev.type = KEY_ESCAPE; return ev; }
        if (c >= 32 && c < 127) {
            ev.type = KEY_CHAR;
            ev.ch = c;
            return ev;
        }
        return ev;
    }

    // Escape sequences
    if (n >= 3 && buf[0] == 27 && buf[1] == '[') {
        switch (buf[2]) {
            case 'A': ev.type = KEY_UP; return ev;
            case 'B': ev.type = KEY_DOWN; return ev;
            case 'C': ev.type = KEY_RIGHT; return ev;
            case 'D': ev.type = KEY_LEFT; return ev;
        }
    }

    return ev;
}
