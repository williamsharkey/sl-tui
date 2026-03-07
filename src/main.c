// main.c — Entry point for SL-TUI C client
#include "app.h"
#include <stdio.h>
#include <string.h>
#include <signal.h>

static App app;

static void signal_handler(int sig) {
    (void)sig;
    app.running = false;
}

int main(int argc, char **argv) {
    // Handle signals gracefully
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    app_init(&app);

    // Parse CLI args
    for (int i = 1; i < argc; i++) {
        if ((strcmp(argv[i], "--username") == 0 || strcmp(argv[i], "-u") == 0) && i + 1 < argc) {
            char *name = argv[++i];
            char *space = strchr(name, ' ');
            if (space) {
                *space = '\0';
                strncpy(app.login.first_name, name, sizeof(app.login.first_name) - 1);
                strncpy(app.login.last_name, space + 1, sizeof(app.login.last_name) - 1);
            } else {
                strncpy(app.login.first_name, name, sizeof(app.login.first_name) - 1);
            }
        } else if ((strcmp(argv[i], "--password") == 0 || strcmp(argv[i], "-p") == 0) && i + 1 < argc) {
            strncpy(app.login.password, argv[++i], sizeof(app.login.password) - 1);
        } else if ((strcmp(argv[i], "--last") == 0 || strcmp(argv[i], "-l") == 0) && i + 1 < argc) {
            strncpy(app.login.last_name, argv[++i], sizeof(app.login.last_name) - 1);
        }
    }

    app_run(&app);
    app_destroy(&app);

    return 0;
}
