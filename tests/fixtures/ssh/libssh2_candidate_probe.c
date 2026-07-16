#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <libssh2.h>

enum probe_exit {
    PROBE_SUCCESS = 0,
    PROBE_USAGE = 2,
    PROBE_FAILURE = 1,
    PROBE_AUTHENTICATION_FAILED = 20,
};

struct keyboard_context {
    const char *answers[2];
    size_t answer_count;
    size_t next_answer;
    int prompt_count;
};

static void keyboard_callback(
    const char *name,
    int name_length,
    const char *instruction,
    int instruction_length,
    int prompt_count,
    const LIBSSH2_USERAUTH_KBDINT_PROMPT *prompts,
    LIBSSH2_USERAUTH_KBDINT_RESPONSE *responses,
    void **abstract
) {
    (void)name;
    (void)name_length;
    (void)instruction;
    (void)instruction_length;
    (void)prompts;

    struct keyboard_context *context = abstract == NULL ? NULL : *abstract;
    if (context == NULL
        || prompt_count < 0
        || context->next_answer + (size_t)prompt_count > context->answer_count) {
        return;
    }

    context->prompt_count += prompt_count;
    for (int index = 0; index < prompt_count; index++) {
        responses[index].text = strdup(context->answers[context->next_answer]);
        if (responses[index].text != NULL) {
            responses[index].length = (unsigned int)strlen(responses[index].text);
        }
        context->next_answer += 1;
    }
}

static int connect_tcp(const char *host, const char *port) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo *addresses = NULL;
    int lookup_status = getaddrinfo(host, port, &hints, &addresses);
    if (lookup_status != 0) {
        fprintf(stderr, "getaddrinfo failed: %s\n", gai_strerror(lookup_status));
        return -1;
    }

    int socket_fd = -1;
    for (const struct addrinfo *address = addresses; address != NULL; address = address->ai_next) {
        socket_fd = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (socket_fd < 0) {
            continue;
        }
        if (connect(socket_fd, address->ai_addr, address->ai_addrlen) == 0) {
            break;
        }
        close(socket_fd);
        socket_fd = -1;
    }

    freeaddrinfo(addresses);
    return socket_fd;
}

static void print_session_error(LIBSSH2_SESSION *session, const char *stage, int status) {
    char *message = NULL;
    int message_length = 0;
    libssh2_session_last_error(session, &message, &message_length, 0);
    fprintf(
        stderr,
        "%s failed: status=%d message=%.*s\n",
        stage,
        status,
        message_length,
        message == NULL ? "" : message
    );
}

static int verify_host_key(
    LIBSSH2_SESSION *session,
    const char *host,
    int port,
    const char *known_hosts_path
) {
    LIBSSH2_KNOWNHOSTS *known_hosts = libssh2_knownhost_init(session);
    if (known_hosts == NULL) {
        return -1;
    }

    int read_status = libssh2_knownhost_readfile(
        known_hosts,
        known_hosts_path,
        LIBSSH2_KNOWNHOST_FILE_OPENSSH
    );
    if (read_status < 0) {
        libssh2_knownhost_free(known_hosts);
        return read_status;
    }

    size_t key_length = 0;
    int key_type = 0;
    const char *key = libssh2_session_hostkey(session, &key_length, &key_type);
    if (key == NULL || key_type != LIBSSH2_HOSTKEY_TYPE_ED25519) {
        libssh2_knownhost_free(known_hosts);
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }

    struct libssh2_knownhost *match = NULL;
    int check_status = libssh2_knownhost_checkp(
        known_hosts,
        host,
        port,
        key,
        key_length,
        LIBSSH2_KNOWNHOST_TYPE_PLAIN
            | LIBSSH2_KNOWNHOST_KEYENC_RAW
            | LIBSSH2_KNOWNHOST_KEY_ED25519,
        &match
    );
    libssh2_knownhost_free(known_hosts);
    return check_status;
}

static int authenticate(
    LIBSSH2_SESSION *session,
    const char *mode,
    const char *username,
    const char *public_key_path,
    const char *private_key_path,
    struct keyboard_context *context
) {
    unsigned int username_length = (unsigned int)strlen(username);
    if (strcmp(mode, "password") == 0) {
        const char *password = "ghosttea-password";
        return libssh2_userauth_password_ex(
            session,
            username,
            username_length,
            password,
            (unsigned int)strlen(password),
            NULL
        );
    }

    if (strcmp(mode, "publickey") == 0) {
        return libssh2_userauth_publickey_fromfile_ex(
            session,
            username,
            username_length,
            public_key_path,
            private_key_path,
            NULL
        );
    }

    if (strcmp(mode, "keyboard") == 0) {
        return libssh2_userauth_keyboard_interactive_ex(
            session,
            username,
            username_length,
            keyboard_callback
        );
    }

    if (strcmp(mode, "partial") == 0) {
        int public_key_status = libssh2_userauth_publickey_fromfile_ex(
            session,
            username,
            username_length,
            public_key_path,
            private_key_path,
            NULL
        );
        fprintf(
            stderr,
            "partial public-key step: status=%d authenticated=%d\n",
            public_key_status,
            libssh2_userauth_authenticated(session)
        );
        int keyboard_status = libssh2_userauth_keyboard_interactive_ex(
            session,
            username,
            username_length,
            keyboard_callback
        );
        fprintf(
            stderr,
            "partial keyboard-interactive step: status=%d authenticated=%d prompts=%d\n",
            keyboard_status,
            libssh2_userauth_authenticated(session),
            context->prompt_count
        );
        return keyboard_status;
    }

    return LIBSSH2_ERROR_INVAL;
}

static int execute_marker(LIBSSH2_SESSION *session) {
    LIBSSH2_CHANNEL *channel = libssh2_channel_open_session(session);
    if (channel == NULL) {
        print_session_error(session, "channel open", libssh2_session_last_errno(session));
        return -1;
    }

    const char *command = "printf 'ghosttea-libssh2-candidate-ok\\n'";
    int execute_status = libssh2_channel_exec(channel, command);
    if (execute_status != 0) {
        print_session_error(session, "channel exec", execute_status);
        libssh2_channel_free(channel);
        return execute_status;
    }

    char buffer[256];
    size_t total = 0;
    for (;;) {
        ssize_t count = libssh2_channel_read(channel, buffer + total, sizeof(buffer) - total - 1);
        if (count > 0) {
            total += (size_t)count;
            if (total == sizeof(buffer) - 1) {
                break;
            }
            continue;
        }
        if (count < 0) {
            print_session_error(session, "channel read", (int)count);
            libssh2_channel_free(channel);
            return (int)count;
        }
        break;
    }
    buffer[total] = '\0';

    libssh2_channel_close(channel);
    int exit_status = libssh2_channel_get_exit_status(channel);
    libssh2_channel_free(channel);
    if (exit_status != 0 || strcmp(buffer, "ghosttea-libssh2-candidate-ok\n") != 0) {
        fprintf(stderr, "unexpected command result: exit=%d stdout=%s\n", exit_status, buffer);
        return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 7) {
        fprintf(
            stderr,
            "usage: %s MODE HOST PORT KNOWN_HOSTS PUBLIC_KEY PRIVATE_KEY\n",
            argv[0]
        );
        return PROBE_USAGE;
    }

    const char *mode = argv[1];
    const char *host = argv[2];
    const char *port_string = argv[3];
    const char *known_hosts_path = argv[4];
    const char *public_key_path = argv[5];
    const char *private_key_path = argv[6];
    int port = atoi(port_string);
    if (port <= 0 || port > 65535) {
        fprintf(stderr, "invalid port: %s\n", port_string);
        return PROBE_USAGE;
    }

    int initialization_status = libssh2_init(0);
    if (initialization_status != 0) {
        fprintf(stderr, "libssh2_init failed: %d\n", initialization_status);
        return PROBE_FAILURE;
    }

    int socket_fd = connect_tcp(host, port_string);
    if (socket_fd < 0) {
        fprintf(stderr, "TCP connection failed\n");
        libssh2_exit();
        return PROBE_FAILURE;
    }

    struct keyboard_context context = {
        .answers = {"ghosttea-password", "123456"},
        .answer_count = 2,
        .next_answer = 0,
        .prompt_count = 0,
    };
    LIBSSH2_SESSION *session = libssh2_session_init_ex(NULL, NULL, NULL, &context);
    if (session == NULL) {
        close(socket_fd);
        libssh2_exit();
        return PROBE_FAILURE;
    }
    libssh2_session_set_blocking(session, 1);
    libssh2_session_set_timeout(session, 10L * 1000L);

    int result = PROBE_FAILURE;
    int handshake_status = libssh2_session_handshake(session, socket_fd);
    if (handshake_status != 0) {
        print_session_error(session, "handshake", handshake_status);
        goto cleanup;
    }

    int host_key_status = verify_host_key(session, host, port, known_hosts_path);
    if (host_key_status != LIBSSH2_KNOWNHOST_CHECK_MATCH) {
        fprintf(stderr, "host-key verification failed: %d\n", host_key_status);
        goto cleanup;
    }

    int authentication_status = authenticate(
        session,
        mode,
        "ghosttea",
        public_key_path,
        private_key_path,
        &context
    );
    if (authentication_status != 0 || libssh2_userauth_authenticated(session) == 0) {
        print_session_error(session, "authentication", authentication_status);
        if (strcmp(mode, "partial") == 0) {
            result = PROBE_AUTHENTICATION_FAILED;
        }
        goto cleanup;
    }
    if ((strcmp(mode, "keyboard") == 0 || strcmp(mode, "partial") == 0)
        && context.prompt_count != 2) {
        fprintf(stderr, "expected two keyboard-interactive prompts, got %d\n", context.prompt_count);
        goto cleanup;
    }

    if (execute_marker(session) != 0) {
        goto cleanup;
    }
    printf("libssh2 candidate %s probe passed\n", mode);
    result = PROBE_SUCCESS;

cleanup:
    libssh2_session_disconnect(session, "fixture probe complete");
    libssh2_session_free(session);
    close(socket_fd);
    libssh2_exit();
    return result;
}
