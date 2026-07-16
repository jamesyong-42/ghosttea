#include <security/pam_appl.h>
#include <security/pam_modules.h>

#include <stdlib.h>
#include <string.h>

static void free_responses(struct pam_response *responses, int count) {
    if (responses == NULL) {
        return;
    }

    for (int index = 0; index < count; index++) {
        if (responses[index].resp != NULL) {
            size_t length = strlen(responses[index].resp);
            memset(responses[index].resp, 0, length);
            free(responses[index].resp);
        }
    }
    free(responses);
}

PAM_EXTERN int pam_sm_authenticate(
    pam_handle_t *pamh,
    int flags,
    int argc,
    const char **argv
) {
    (void)flags;
    (void)argc;
    (void)argv;

    const void *conversation_item = NULL;
    int status = pam_get_item(pamh, PAM_CONV, &conversation_item);
    if (status != PAM_SUCCESS || conversation_item == NULL) {
        return PAM_SYSTEM_ERR;
    }

    const struct pam_conv *conversation = conversation_item;
    const struct pam_message messages[] = {
        {PAM_PROMPT_ECHO_OFF, "Fixture password: "},
        {PAM_PROMPT_ECHO_ON, "Verification code: "},
    };
    const struct pam_message *message_pointers[] = {&messages[0], &messages[1]};
    struct pam_response *responses = NULL;

    status = conversation->conv(2, message_pointers, &responses, conversation->appdata_ptr);
    if (status != PAM_SUCCESS || responses == NULL) {
        free_responses(responses, 2);
        return PAM_AUTH_ERR;
    }

    const int valid = responses[0].resp != NULL
        && responses[1].resp != NULL
        && strcmp(responses[0].resp, "ghosttea-password") == 0
        && strcmp(responses[1].resp, "123456") == 0;
    free_responses(responses, 2);
    return valid ? PAM_SUCCESS : PAM_AUTH_ERR;
}

PAM_EXTERN int pam_sm_setcred(
    pam_handle_t *pamh,
    int flags,
    int argc,
    const char **argv
) {
    (void)pamh;
    (void)flags;
    (void)argc;
    (void)argv;
    return PAM_SUCCESS;
}
