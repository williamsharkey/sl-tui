// credentials.c — Save/load login credentials
#include "credentials.h"
#include "cjson/cJSON.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>

static void get_cred_path(char *buf, size_t len) {
    const char *home = getenv("HOME");
    if (!home) home = "/tmp";
    snprintf(buf, len, "%s/.sl-tui/credentials.json", home);
}

static void get_cred_dir(char *buf, size_t len) {
    const char *home = getenv("HOME");
    if (!home) home = "/tmp";
    snprintf(buf, len, "%s/.sl-tui", home);
}

bool credentials_load(Credentials *out) {
    char path[512];
    get_cred_path(path, sizeof(path));

    FILE *f = fopen(path, "r");
    if (!f) return false;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 4096) { fclose(f); return false; }

    char *data = malloc(sz + 1);
    fread(data, 1, sz, f);
    data[sz] = '\0';
    fclose(f);

    cJSON *json = cJSON_Parse(data);
    free(data);
    if (!json) return false;

    const cJSON *fn = cJSON_GetObjectItem(json, "firstName");
    const cJSON *pw = cJSON_GetObjectItem(json, "password");
    if (!fn || !cJSON_IsString(fn) || !pw || !cJSON_IsString(pw)) {
        cJSON_Delete(json);
        return false;
    }

    // Check staleness (30 days)
    const cJSON *saved_at = cJSON_GetObjectItem(json, "savedAt");
    if (saved_at && cJSON_IsNumber(saved_at)) {
        double age_ms = (double)time(NULL) * 1000.0 - saved_at->valuedouble;
        if (age_ms > 30.0 * 24 * 60 * 60 * 1000) {
            cJSON_Delete(json);
            return false;
        }
    }

    strncpy(out->first_name, fn->valuestring, sizeof(out->first_name) - 1);
    const cJSON *ln = cJSON_GetObjectItem(json, "lastName");
    strncpy(out->last_name, ln && cJSON_IsString(ln) ? ln->valuestring : "Resident",
            sizeof(out->last_name) - 1);
    strncpy(out->password, pw->valuestring, sizeof(out->password) - 1);

    cJSON_Delete(json);
    return true;
}

void credentials_save(const Credentials *creds) {
    char dir[512], path[512];
    get_cred_dir(dir, sizeof(dir));
    get_cred_path(path, sizeof(path));

    mkdir(dir, 0700);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "firstName", creds->first_name);
    cJSON_AddStringToObject(json, "lastName", creds->last_name);
    cJSON_AddStringToObject(json, "password", creds->password);
    cJSON_AddNumberToObject(json, "savedAt", (double)time(NULL) * 1000.0);

    char *str = cJSON_Print(json);
    cJSON_Delete(json);

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
        write(fd, str, strlen(str));
        write(fd, "\n", 1);
        close(fd);
    }
    free(str);
}

void credentials_clear(void) {
    char path[512];
    get_cred_path(path, sizeof(path));
    unlink(path);
}
