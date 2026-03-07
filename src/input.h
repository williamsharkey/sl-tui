// input.h — Raw stdin keypress reading
#ifndef INPUT_H
#define INPUT_H

#include <stdbool.h>

typedef enum {
    KEY_NONE,
    KEY_CHAR,        // printable character in key.ch
    KEY_RETURN,
    KEY_BACKSPACE,
    KEY_TAB,
    KEY_ESCAPE,
    KEY_UP,
    KEY_DOWN,
    KEY_LEFT,
    KEY_RIGHT,
    KEY_CTRL_C,
} KeyType;

typedef struct {
    KeyType type;
    char ch;   // for KEY_CHAR
} KeyEvent;

// Read a single keypress (non-blocking). Returns KEY_NONE if nothing available.
KeyEvent input_read_key(void);

#endif
