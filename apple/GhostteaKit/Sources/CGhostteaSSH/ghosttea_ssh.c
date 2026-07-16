#include "ghosttea_ssh.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <pthread.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <libssh2.h>

struct ghosttea_ssh_session {
    int socket_fd;
    LIBSSH2_SESSION *session;
    LIBSSH2_CHANNEL *channel;
    char **keyboard_answers;
    size_t keyboard_answer_count;
    size_t keyboard_answer_capacity;
    size_t keyboard_next_answer;
    int keyboard_prompt_count;
};

static pthread_once_t libssh2_initialization_once = PTHREAD_ONCE_INIT;
static int libssh2_initialization_status = -1;

static void initialize_libssh2(void) {
    libssh2_initialization_status = libssh2_init(0);
}

static void write_error(char *buffer, size_t length, const char *message) {
    if (buffer == NULL || length == 0) {
        return;
    }
    snprintf(buffer, length, "%s", message == NULL ? "unknown error" : message);
}

static void clear_keyboard_answers(ghosttea_ssh_session_t *session) {
    if (session == NULL) {
        return;
    }
    for (size_t index = 0; index < session->keyboard_answer_count; index++) {
        if (session->keyboard_answers[index] != NULL) {
            size_t length = strlen(session->keyboard_answers[index]);
            memset(session->keyboard_answers[index], 0, length);
            free(session->keyboard_answers[index]);
        }
    }
    free(session->keyboard_answers);
    session->keyboard_answers = NULL;
    session->keyboard_answer_count = 0;
    session->keyboard_answer_capacity = 0;
    session->keyboard_next_answer = 0;
    session->keyboard_prompt_count = 0;
}

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

    ghosttea_ssh_session_t *session = abstract == NULL ? NULL : *abstract;
    if (session == NULL
        || prompt_count < 0
        || session->keyboard_next_answer + (size_t)prompt_count
            > session->keyboard_answer_count) {
        return;
    }

    session->keyboard_prompt_count += prompt_count;
    for (int index = 0; index < prompt_count; index++) {
        const char *answer = session->keyboard_answers[session->keyboard_next_answer];
        responses[index].text = strdup(answer);
        if (responses[index].text != NULL) {
            responses[index].length = (unsigned int)strlen(responses[index].text);
        }
        session->keyboard_next_answer += 1;
    }
}

int ghosttea_ssh_tcp_connect(
    const char *host,
    const char *port,
    char *error_buffer,
    size_t error_buffer_length
) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo *addresses = NULL;
    int lookup_status = getaddrinfo(host, port, &hints, &addresses);
    if (lookup_status != 0) {
        write_error(error_buffer, error_buffer_length, gai_strerror(lookup_status));
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

    if (socket_fd < 0) {
        write_error(error_buffer, error_buffer_length, strerror(errno));
        return -1;
    }
    int flags = fcntl(socket_fd, F_GETFL, 0);
    if (flags < 0 || fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        write_error(error_buffer, error_buffer_length, strerror(errno));
        close(socket_fd);
        return -1;
    }
    return socket_fd;
}

void ghosttea_ssh_socket_close(int socket_fd) {
    if (socket_fd >= 0) {
        close(socket_fd);
    }
}

ghosttea_ssh_session_t *ghosttea_ssh_session_create(int socket_fd) {
    pthread_once(&libssh2_initialization_once, initialize_libssh2);
    if (libssh2_initialization_status != 0) {
        return NULL;
    }

    ghosttea_ssh_session_t *wrapper = calloc(1, sizeof(*wrapper));
    if (wrapper == NULL) {
        return NULL;
    }
    wrapper->socket_fd = socket_fd;
    wrapper->session = libssh2_session_init_ex(NULL, NULL, NULL, wrapper);
    if (wrapper->session == NULL) {
        free(wrapper);
        return NULL;
    }
    libssh2_session_set_blocking(wrapper->session, 0);
    return wrapper;
}

void ghosttea_ssh_session_shutdown_socket(ghosttea_ssh_session_t *session) {
    if (session != NULL && session->socket_fd >= 0) {
        shutdown(session->socket_fd, SHUT_RDWR);
    }
}

void ghosttea_ssh_session_destroy(ghosttea_ssh_session_t *session) {
    if (session == NULL) {
        return;
    }
    if (session->channel != NULL) {
        libssh2_channel_free(session->channel);
    }
    clear_keyboard_answers(session);
    libssh2_session_free(session->session);
    ghosttea_ssh_socket_close(session->socket_fd);
    memset(session, 0, sizeof(*session));
    free(session);
}

int ghosttea_ssh_session_handshake(ghosttea_ssh_session_t *session) {
    return libssh2_session_handshake(session->session, session->socket_fd);
}

int ghosttea_ssh_session_wait(ghosttea_ssh_session_t *session, int timeout_milliseconds) {
    int directions = libssh2_session_block_directions(session->session);
    short events = 0;
    if ((directions & LIBSSH2_SESSION_BLOCK_INBOUND) != 0) {
        events |= POLLIN;
    }
    if ((directions & LIBSSH2_SESSION_BLOCK_OUTBOUND) != 0) {
        events |= POLLOUT;
    }
    if (events == 0) {
        events = POLLIN | POLLOUT;
    }

    struct pollfd descriptor = {
        .fd = session->socket_fd,
        .events = events,
        .revents = 0,
    };
    int status = poll(&descriptor, 1, timeout_milliseconds);
    if (status < 0 && errno == EINTR) {
        return 0;
    }
    if (status <= 0) {
        return status;
    }
    if ((descriptor.revents & events) != 0) {
        return 1;
    }
    return (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) == 0 ? 0 : -1;
}

int ghosttea_ssh_session_verify_known_host(
    ghosttea_ssh_session_t *session,
    const char *host,
    int port,
    const char *known_hosts_path
) {
    LIBSSH2_KNOWNHOSTS *known_hosts = libssh2_knownhost_init(session->session);
    if (known_hosts == NULL) {
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }
    int read_status = libssh2_knownhost_readfile(
        known_hosts,
        known_hosts_path,
        LIBSSH2_KNOWNHOST_FILE_OPENSSH
    );
    if (read_status < 0) {
        libssh2_knownhost_free(known_hosts);
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }

    size_t key_length = 0;
    int key_type = 0;
    const char *key = libssh2_session_hostkey(session->session, &key_length, &key_type);
    int known_key_type = LIBSSH2_KNOWNHOST_KEY_UNKNOWN;
    if (key_type == LIBSSH2_HOSTKEY_TYPE_ED25519) {
        known_key_type = LIBSSH2_KNOWNHOST_KEY_ED25519;
    }
    if (key == NULL || known_key_type == LIBSSH2_KNOWNHOST_KEY_UNKNOWN) {
        libssh2_knownhost_free(known_hosts);
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }

    struct libssh2_knownhost *match = NULL;
    int result = libssh2_knownhost_checkp(
        known_hosts,
        host,
        port,
        key,
        key_length,
        LIBSSH2_KNOWNHOST_TYPE_PLAIN | LIBSSH2_KNOWNHOST_KEYENC_RAW | known_key_type,
        &match
    );
    libssh2_knownhost_free(known_hosts);
    return result;
}

const char *ghosttea_ssh_session_negotiated_kex(ghosttea_ssh_session_t *session) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_KEX);
}

const char *ghosttea_ssh_session_negotiated_host_key(ghosttea_ssh_session_t *session) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_HOSTKEY);
}

const char *ghosttea_ssh_session_negotiated_cipher_client_to_server(
    ghosttea_ssh_session_t *session
) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_CRYPT_CS);
}

const char *ghosttea_ssh_session_negotiated_cipher_server_to_client(
    ghosttea_ssh_session_t *session
) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_CRYPT_SC);
}

const char *ghosttea_ssh_session_negotiated_mac_client_to_server(
    ghosttea_ssh_session_t *session
) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_MAC_CS);
}

const char *ghosttea_ssh_session_negotiated_mac_server_to_client(
    ghosttea_ssh_session_t *session
) {
    return libssh2_session_methods(session->session, LIBSSH2_METHOD_MAC_SC);
}

int ghosttea_ssh_session_auth_password(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *password
) {
    return libssh2_userauth_password_ex(
        session->session,
        username,
        (unsigned int)strlen(username),
        password,
        (unsigned int)strlen(password),
        NULL
    );
}

int ghosttea_ssh_session_auth_public_key(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *public_key_path,
    const char *private_key_path,
    const char *passphrase
) {
    return libssh2_userauth_publickey_fromfile_ex(
        session->session,
        username,
        (unsigned int)strlen(username),
        public_key_path,
        private_key_path,
        passphrase
    );
}

void ghosttea_ssh_session_reset_keyboard_answers(ghosttea_ssh_session_t *session) {
    clear_keyboard_answers(session);
}

int ghosttea_ssh_session_add_keyboard_answer(
    ghosttea_ssh_session_t *session,
    const char *answer
) {
    if (session->keyboard_answer_count == session->keyboard_answer_capacity) {
        size_t capacity = session->keyboard_answer_capacity == 0
            ? 4
            : session->keyboard_answer_capacity * 2;
        char **answers = realloc(session->keyboard_answers, capacity * sizeof(*answers));
        if (answers == NULL) {
            return -1;
        }
        session->keyboard_answers = answers;
        session->keyboard_answer_capacity = capacity;
    }
    char *copy = strdup(answer);
    if (copy == NULL) {
        return -1;
    }
    session->keyboard_answers[session->keyboard_answer_count] = copy;
    session->keyboard_answer_count += 1;
    return 0;
}

int ghosttea_ssh_session_auth_keyboard_interactive(
    ghosttea_ssh_session_t *session,
    const char *username
) {
    return libssh2_userauth_keyboard_interactive_ex(
        session->session,
        username,
        (unsigned int)strlen(username),
        keyboard_callback
    );
}

int ghosttea_ssh_session_is_authenticated(const ghosttea_ssh_session_t *session) {
    return libssh2_userauth_authenticated(session->session);
}

int ghosttea_ssh_session_keyboard_prompt_count(const ghosttea_ssh_session_t *session) {
    return session->keyboard_prompt_count;
}

int ghosttea_ssh_session_open_channel(ghosttea_ssh_session_t *session) {
    if (session->channel != NULL) {
        return 0;
    }
    session->channel = libssh2_channel_open_session(session->session);
    if (session->channel == NULL) {
        return libssh2_session_last_errno(session->session);
    }
    return 0;
}

int ghosttea_ssh_session_request_pty(
    ghosttea_ssh_session_t *session,
    const char *terminal_type,
    int columns,
    int rows
) {
    return libssh2_channel_request_pty_ex(
        session->channel,
        terminal_type,
        (unsigned int)strlen(terminal_type),
        NULL,
        0,
        columns,
        rows,
        0,
        0
    );
}

int ghosttea_ssh_session_start_shell(ghosttea_ssh_session_t *session) {
    return libssh2_channel_shell(session->channel);
}

int ghosttea_ssh_session_resize(
    ghosttea_ssh_session_t *session,
    int columns,
    int rows
) {
    return libssh2_channel_request_pty_size_ex(session->channel, columns, rows, 0, 0);
}

long ghosttea_ssh_session_read(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
) {
    return (long)libssh2_channel_read(session->channel, (char *)buffer, buffer_length);
}

long ghosttea_ssh_session_write(
    ghosttea_ssh_session_t *session,
    const uint8_t *buffer,
    size_t buffer_length
) {
    return (long)libssh2_channel_write(
        session->channel,
        (const char *)buffer,
        buffer_length
    );
}

int ghosttea_ssh_session_signal_interrupt(ghosttea_ssh_session_t *session) {
    return libssh2_channel_signal(session->channel, "INT");
}

int ghosttea_ssh_session_is_eof(const ghosttea_ssh_session_t *session) {
    return libssh2_channel_eof(session->channel);
}

int ghosttea_ssh_session_last_error(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
) {
    char *message = NULL;
    int message_length = 0;
    int status = libssh2_session_last_error(
        session->session,
        &message,
        &message_length,
        0
    );
    if (buffer != NULL && buffer_length > 0) {
        int copy_length = message_length;
        if (copy_length < 0) {
            copy_length = 0;
        }
        if ((size_t)copy_length >= buffer_length) {
            copy_length = (int)buffer_length - 1;
        }
        if (copy_length > 0 && message != NULL) {
            memcpy(buffer, message, (size_t)copy_length);
        }
        buffer[copy_length] = '\0';
    }
    return status;
}
