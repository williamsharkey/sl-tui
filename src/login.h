// login.h — ASCII login form
#ifndef LOGIN_H
#define LOGIN_H

#include <stdbool.h>

typedef enum { FIELD_FIRST_NAME, FIELD_LAST_NAME, FIELD_PASSWORD } LoginField;

typedef struct {
    char first_name[128];
    char last_name[128];
    char password[128];
    LoginField active_field;
    char error[256];
} LoginState;

void login_state_init(LoginState *s);
void login_render(const LoginState *s, int cols, int rows);
void login_render_loading(int cols, int rows, const char *message);
void login_next_field(LoginState *s);
void login_append_char(LoginState *s, char c);
void login_backspace(LoginState *s);

#endif
