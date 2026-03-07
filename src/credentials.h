// credentials.h — Save/load login credentials to ~/.sl-tui/credentials.json
#ifndef CREDENTIALS_H
#define CREDENTIALS_H

#include <stdbool.h>

typedef struct {
    char first_name[128];
    char last_name[128];
    char password[128];
} Credentials;

bool credentials_load(Credentials *out);
void credentials_save(const Credentials *creds);
void credentials_clear(void);

#endif
