#include "ghosttea_ssh.h"

#include <errno.h>
#include <dns_sd.h>
#include <fcntl.h>
#include <limits.h>
#include <netdb.h>
#include <netinet/in.h>
#include <pthread.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
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
    pthread_mutex_t keyboard_mutex;
    pthread_cond_t keyboard_condition;
    int keyboard_broker_enabled;
    int keyboard_broker_prompt_ready;
    int keyboard_broker_answers_ready;
    int keyboard_broker_cancelled;
    char *keyboard_broker_name;
    char *keyboard_broker_instruction;
    char **keyboard_broker_prompts;
    int *keyboard_broker_echo;
    int keyboard_broker_prompt_count;
    uint64_t socket_bytes_received;
    uint64_t socket_bytes_sent;
};

struct ghosttea_ssh_connector {
    pthread_mutex_t mutex;
    int socket_fd;
    int cancelled;
};

#define GHOSTTEA_SSH_MAX_RESOLVED_ADDRESSES 32

struct ghosttea_ssh_resolved_address {
    struct sockaddr_storage storage;
    socklen_t length;
};

struct ghosttea_ssh_resolver_result {
    struct ghosttea_ssh_resolved_address addresses[GHOSTTEA_SSH_MAX_RESOLVED_ADDRESSES];
    size_t count;
    int batch_complete;
    DNSServiceErrorType error;
};

static pthread_once_t libssh2_initialization_once = PTHREAD_ONCE_INIT;
static int libssh2_initialization_status = -1;
static pthread_mutex_t known_hosts_write_mutex = PTHREAD_MUTEX_INITIALIZER;

static void initialize_libssh2(void) {
    libssh2_initialization_status = libssh2_init(0);
}

static void write_error(char *buffer, size_t length, const char *message) {
    if (buffer == NULL || length == 0) {
        return;
    }
    snprintf(buffer, length, "%s", message == NULL ? "unknown error" : message);
}

static ssize_t normalize_socket_result(ssize_t result) {
    if (result >= 0) {
        return result;
    }
    int error = errno;
    if (error == EINTR || error == ENOENT || error == EAGAIN || error == EWOULDBLOCK) {
        return -EAGAIN;
    }
    return -error;
}

static LIBSSH2_RECV_FUNC(counting_receive) {
    ssize_t result = recv(socket, buffer, length, flags);
    if (result > 0 && abstract != NULL && *abstract != NULL) {
        ghosttea_ssh_session_t *session = *abstract;
        session->socket_bytes_received += (uint64_t)result;
    }
    return normalize_socket_result(result);
}

static LIBSSH2_SEND_FUNC(counting_send) {
    ssize_t result = send(socket, buffer, length, flags);
    if (result > 0 && abstract != NULL && *abstract != NULL) {
        ghosttea_ssh_session_t *session = *abstract;
        session->socket_bytes_sent += (uint64_t)result;
    }
    return normalize_socket_result(result);
}

static int64_t monotonic_milliseconds(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) {
        return -1;
    }
    return (int64_t)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

ghosttea_ssh_connector_t *ghosttea_ssh_connector_create(void) {
    ghosttea_ssh_connector_t *connector = calloc(1, sizeof(*connector));
    if (connector == NULL) {
        return NULL;
    }
    connector->socket_fd = -1;
    if (pthread_mutex_init(&connector->mutex, NULL) != 0) {
        free(connector);
        return NULL;
    }
    return connector;
}

void ghosttea_ssh_connector_cancel(ghosttea_ssh_connector_t *connector) {
    if (connector == NULL) {
        return;
    }
    pthread_mutex_lock(&connector->mutex);
    connector->cancelled = 1;
    if (connector->socket_fd >= 0) {
        shutdown(connector->socket_fd, SHUT_RDWR);
    }
    pthread_mutex_unlock(&connector->mutex);
}

static int connector_is_cancelled(ghosttea_ssh_connector_t *connector) {
    pthread_mutex_lock(&connector->mutex);
    int cancelled = connector->cancelled;
    pthread_mutex_unlock(&connector->mutex);
    return cancelled;
}

static int connector_set_socket(
    ghosttea_ssh_connector_t *connector,
    int socket_fd
) {
    pthread_mutex_lock(&connector->mutex);
    int cancelled = connector->cancelled;
    connector->socket_fd = cancelled == 0 ? socket_fd : -1;
    pthread_mutex_unlock(&connector->mutex);
    return cancelled == 0 ? 0 : -1;
}

static void connector_clear_socket(ghosttea_ssh_connector_t *connector) {
    pthread_mutex_lock(&connector->mutex);
    connector->socket_fd = -1;
    pthread_mutex_unlock(&connector->mutex);
}

static int append_resolved_address(
    struct ghosttea_ssh_resolver_result *result,
    const struct sockaddr *address,
    uint16_t port
) {
    if (result->count >= GHOSTTEA_SSH_MAX_RESOLVED_ADDRESSES) {
        return 0;
    }
    socklen_t length;
    if (address->sa_family == AF_INET) {
        length = sizeof(struct sockaddr_in);
    } else if (address->sa_family == AF_INET6) {
        length = sizeof(struct sockaddr_in6);
    } else {
        return 0;
    }
    for (size_t index = 0; index < result->count; index++) {
        if (result->addresses[index].length == length
            && memcmp(&result->addresses[index].storage, address, length) == 0) {
            return 0;
        }
    }
    struct ghosttea_ssh_resolved_address *resolved = &result->addresses[result->count++];
    memset(resolved, 0, sizeof(*resolved));
    memcpy(&resolved->storage, address, length);
    resolved->length = length;
    if (address->sa_family == AF_INET) {
        ((struct sockaddr_in *)&resolved->storage)->sin_port = port;
    } else {
        ((struct sockaddr_in6 *)&resolved->storage)->sin6_port = port;
    }
    return 1;
}

static void resolved_address_callback(
    DNSServiceRef service,
    DNSServiceFlags flags,
    uint32_t interface_index,
    DNSServiceErrorType error,
    const char *hostname,
    const struct sockaddr *address,
    uint32_t ttl,
    void *context
) {
    (void)service;
    (void)interface_index;
    (void)hostname;
    (void)ttl;
    struct ghosttea_ssh_resolver_result *result = context;
    if (error != kDNSServiceErr_NoError) {
        result->error = error;
    } else if ((flags & kDNSServiceFlagsAdd) != 0 && address != NULL) {
        append_resolved_address(result, address, 0);
    }
    if ((flags & kDNSServiceFlagsMoreComing) == 0) {
        result->batch_complete = 1;
    }
}

static int resolve_numeric_address(
    const char *host,
    uint16_t port,
    struct ghosttea_ssh_resolver_result *result
) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_NUMERICHOST;
    struct addrinfo *addresses = NULL;
    int status = getaddrinfo(host, NULL, &hints, &addresses);
    if (status != 0) {
        return 0;
    }
    for (const struct addrinfo *address = addresses; address != NULL; address = address->ai_next) {
        append_resolved_address(result, address->ai_addr, port);
    }
    freeaddrinfo(addresses);
    result->batch_complete = 1;
    return result->count > 0;
}

static int resolve_host(
    ghosttea_ssh_connector_t *connector,
    const char *host,
    uint16_t port,
    int64_t deadline,
    struct ghosttea_ssh_resolver_result *result,
    char *error_buffer,
    size_t error_buffer_length
) {
    memset(result, 0, sizeof(*result));
    result->error = kDNSServiceErr_NoError;
    if (resolve_numeric_address(host, port, result) != 0) {
        return 0;
    }
    if (connector_is_cancelled(connector) != 0) {
        return GHOSTTEA_SSH_CONNECT_CANCELLED;
    }
    DNSServiceRef resolver = NULL;
    DNSServiceErrorType start_status = DNSServiceGetAddrInfo(
        &resolver,
        0,
        0,
        kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6,
        host,
        resolved_address_callback,
        result
    );
    if (start_status != kDNSServiceErr_NoError || resolver == NULL) {
        snprintf(error_buffer, error_buffer_length, "DNS lookup failed (%d)", start_status);
        return -1;
    }
    int resolver_socket = DNSServiceRefSockFD(resolver);
    if (resolver_socket < 0) {
        DNSServiceRefDeallocate(resolver);
        write_error(error_buffer, error_buffer_length, "DNS resolver did not provide a socket");
        return -1;
    }
    while (result->batch_complete == 0) {
        if (connector_is_cancelled(connector) != 0) {
            DNSServiceRefDeallocate(resolver);
            return GHOSTTEA_SSH_CONNECT_CANCELLED;
        }
        int64_t now = monotonic_milliseconds();
        if (now < 0 || now >= deadline) {
            DNSServiceRefDeallocate(resolver);
            write_error(error_buffer, error_buffer_length, "TCP connection timed out during DNS lookup");
            return GHOSTTEA_SSH_CONNECT_TIMEOUT;
        }
        int remaining = (int)(deadline - now);
        int poll_timeout = remaining < 100 ? remaining : 100;
        struct pollfd descriptor = {
            .fd = resolver_socket,
            .events = POLLIN,
            .revents = 0,
        };
        int poll_status = poll(&descriptor, 1, poll_timeout);
        if (poll_status < 0 && errno == EINTR) {
            continue;
        }
        if (poll_status < 0) {
            DNSServiceRefDeallocate(resolver);
            write_error(error_buffer, error_buffer_length, strerror(errno));
            return -1;
        }
        if (poll_status == 0) {
            continue;
        }
        DNSServiceErrorType process_status = DNSServiceProcessResult(resolver);
        if (process_status != kDNSServiceErr_NoError) {
            DNSServiceRefDeallocate(resolver);
            snprintf(error_buffer, error_buffer_length, "DNS lookup failed (%d)", process_status);
            return -1;
        }
    }
    DNSServiceRefDeallocate(resolver);
    if (result->count == 0) {
        snprintf(error_buffer, error_buffer_length, "DNS lookup failed (%d)", result->error);
        return -1;
    }
    for (size_t index = 0; index < result->count; index++) {
        struct sockaddr *address = (struct sockaddr *)&result->addresses[index].storage;
        if (address->sa_family == AF_INET) {
            ((struct sockaddr_in *)address)->sin_port = port;
        } else {
            ((struct sockaddr_in6 *)address)->sin6_port = port;
        }
    }
    return 0;
}

int ghosttea_ssh_connector_run(
    ghosttea_ssh_connector_t *connector,
    const char *host,
    const char *port,
    int timeout_milliseconds,
    char *error_buffer,
    size_t error_buffer_length
) {
    if (connector == NULL || host == NULL || port == NULL || timeout_milliseconds <= 0) {
        write_error(error_buffer, error_buffer_length, "invalid connector configuration");
        return -1;
    }
    int64_t start = monotonic_milliseconds();
    if (start < 0) {
        write_error(error_buffer, error_buffer_length, strerror(errno));
        return -1;
    }
    int64_t deadline = start + timeout_milliseconds;
    char *port_end = NULL;
    long parsed_port = strtol(port, &port_end, 10);
    if (port_end == port || *port_end != '\0' || parsed_port < 1 || parsed_port > UINT16_MAX) {
        write_error(error_buffer, error_buffer_length, "invalid TCP port");
        return -1;
    }
    struct ghosttea_ssh_resolver_result resolver_result;
    int resolve_status = resolve_host(
        connector,
        host,
        htons((uint16_t)parsed_port),
        deadline,
        &resolver_result,
        error_buffer,
        error_buffer_length
    );
    if (resolve_status != 0) {
        return resolve_status;
    }

    for (size_t address_index = 0; address_index < resolver_result.count; address_index++) {
        struct ghosttea_ssh_resolved_address *address = &resolver_result.addresses[address_index];
        if (connector_is_cancelled(connector) != 0) {
            return GHOSTTEA_SSH_CONNECT_CANCELLED;
        }
        struct sockaddr *socket_address = (struct sockaddr *)&address->storage;
        int socket_fd = socket(socket_address->sa_family, SOCK_STREAM, 0);
        if (socket_fd < 0) {
            continue;
        }
        int flags = fcntl(socket_fd, F_GETFL, 0);
        if (flags < 0 || fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK) < 0) {
            close(socket_fd);
            continue;
        }
        if (connector_set_socket(connector, socket_fd) != 0) {
            close(socket_fd);
            return GHOSTTEA_SSH_CONNECT_CANCELLED;
        }

        int connect_status = connect(socket_fd, socket_address, address->length);
        if (connect_status == 0) {
            connector_clear_socket(connector);
            return socket_fd;
        }
        if (errno != EINPROGRESS) {
            connector_clear_socket(connector);
            close(socket_fd);
            continue;
        }

        for (;;) {
            if (connector_is_cancelled(connector) != 0) {
                connector_clear_socket(connector);
                close(socket_fd);
                return GHOSTTEA_SSH_CONNECT_CANCELLED;
            }
            int64_t now = monotonic_milliseconds();
            if (now < 0 || now >= deadline) {
                connector_clear_socket(connector);
                close(socket_fd);
                write_error(error_buffer, error_buffer_length, "TCP connection timed out");
                return GHOSTTEA_SSH_CONNECT_TIMEOUT;
            }
            int remaining = (int)(deadline - now);
            int poll_timeout = remaining < 100 ? remaining : 100;
            struct pollfd descriptor = {
                .fd = socket_fd,
                .events = POLLOUT,
                .revents = 0,
            };
            int poll_status = poll(&descriptor, 1, poll_timeout);
            if (poll_status < 0 && errno == EINTR) {
                continue;
            }
            if (poll_status < 0) {
                break;
            }
            if (poll_status == 0) {
                continue;
            }
            int socket_error = 0;
            socklen_t error_length = sizeof(socket_error);
            if (getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_length) == 0
                && socket_error == 0) {
                connector_clear_socket(connector);
                return socket_fd;
            }
            if (socket_error != 0) {
                errno = socket_error;
            }
            break;
        }
        connector_clear_socket(connector);
        close(socket_fd);
    }
    if (connector_is_cancelled(connector) != 0) {
        return GHOSTTEA_SSH_CONNECT_CANCELLED;
    }
    write_error(error_buffer, error_buffer_length, strerror(errno));
    return -1;
}

void ghosttea_ssh_connector_destroy(ghosttea_ssh_connector_t *connector) {
    if (connector == NULL) {
        return;
    }
    pthread_mutex_destroy(&connector->mutex);
    free(connector);
}

static void clear_keyboard_answer_values(ghosttea_ssh_session_t *session) {
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
}

static void clear_keyboard_answers(ghosttea_ssh_session_t *session) {
    clear_keyboard_answer_values(session);
    session->keyboard_prompt_count = 0;
}

static char *copy_sized_string(const char *text, int length) {
    if (length < 0 || (text == NULL && length > 0)) {
        return NULL;
    }
    char *copy = malloc((size_t)length + 1);
    if (copy == NULL) {
        return NULL;
    }
    if (length > 0) {
        memcpy(copy, text, (size_t)length);
    }
    copy[length] = '\0';
    return copy;
}

static void clear_keyboard_broker_prompt(ghosttea_ssh_session_t *session) {
    free(session->keyboard_broker_name);
    free(session->keyboard_broker_instruction);
    for (int index = 0; index < session->keyboard_broker_prompt_count; index++) {
        free(session->keyboard_broker_prompts[index]);
    }
    free(session->keyboard_broker_prompts);
    free(session->keyboard_broker_echo);
    session->keyboard_broker_name = NULL;
    session->keyboard_broker_instruction = NULL;
    session->keyboard_broker_prompts = NULL;
    session->keyboard_broker_echo = NULL;
    session->keyboard_broker_prompt_count = 0;
    session->keyboard_broker_prompt_ready = 0;
}

static int store_keyboard_broker_prompt(
    ghosttea_ssh_session_t *session,
    const char *name,
    int name_length,
    const char *instruction,
    int instruction_length,
    int prompt_count,
    const LIBSSH2_USERAUTH_KBDINT_PROMPT *prompts
) {
    clear_keyboard_broker_prompt(session);
    session->keyboard_broker_name = copy_sized_string(name, name_length);
    session->keyboard_broker_instruction = copy_sized_string(instruction, instruction_length);
    if (session->keyboard_broker_name == NULL
        || session->keyboard_broker_instruction == NULL) {
        clear_keyboard_broker_prompt(session);
        return -1;
    }
    if (prompt_count == 0) {
        return 0;
    }
    session->keyboard_broker_prompts = calloc(
        (size_t)prompt_count,
        sizeof(*session->keyboard_broker_prompts)
    );
    session->keyboard_broker_echo = calloc(
        (size_t)prompt_count,
        sizeof(*session->keyboard_broker_echo)
    );
    if (session->keyboard_broker_prompts == NULL
        || session->keyboard_broker_echo == NULL) {
        clear_keyboard_broker_prompt(session);
        return -1;
    }
    session->keyboard_broker_prompt_count = prompt_count;
    for (int index = 0; index < prompt_count; index++) {
        session->keyboard_broker_prompts[index] = copy_sized_string(
            (const char *)prompts[index].text,
            (int)prompts[index].length
        );
        session->keyboard_broker_echo[index] = prompts[index].echo;
        if (session->keyboard_broker_prompts[index] == NULL) {
            clear_keyboard_broker_prompt(session);
            return -1;
        }
    }
    return 0;
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
    ghosttea_ssh_session_t *session = abstract == NULL ? NULL : *abstract;
    if (session == NULL || prompt_count < 0) {
        return;
    }

    if (session->keyboard_broker_enabled != 0) {
        pthread_mutex_lock(&session->keyboard_mutex);
        if (store_keyboard_broker_prompt(
                session,
                name,
                name_length,
                instruction,
                instruction_length,
                prompt_count,
                prompts
            ) != 0) {
            session->keyboard_broker_cancelled = 1;
        } else {
            session->keyboard_broker_prompt_ready = 1;
            pthread_cond_broadcast(&session->keyboard_condition);
        }
        while (session->keyboard_broker_answers_ready == 0
            && session->keyboard_broker_cancelled == 0) {
            pthread_cond_wait(&session->keyboard_condition, &session->keyboard_mutex);
        }
        if (session->keyboard_broker_cancelled == 0
            && session->keyboard_answer_count == (size_t)prompt_count) {
            for (int index = 0; index < prompt_count; index++) {
                responses[index].text = strdup(session->keyboard_answers[index]);
                if (responses[index].text != NULL) {
                    responses[index].length = (unsigned int)strlen(responses[index].text);
                }
            }
            session->keyboard_prompt_count += prompt_count;
        }
        clear_keyboard_answer_values(session);
        session->keyboard_broker_answers_ready = 0;
        pthread_mutex_unlock(&session->keyboard_mutex);
        return;
    }

    if (session->keyboard_next_answer + (size_t)prompt_count
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
    if (pthread_mutex_init(&wrapper->keyboard_mutex, NULL) != 0) {
        free(wrapper);
        return NULL;
    }
    if (pthread_cond_init(&wrapper->keyboard_condition, NULL) != 0) {
        pthread_mutex_destroy(&wrapper->keyboard_mutex);
        free(wrapper);
        return NULL;
    }
    wrapper->socket_fd = socket_fd;
    wrapper->session = libssh2_session_init_ex(NULL, NULL, NULL, wrapper);
    if (wrapper->session == NULL) {
        pthread_cond_destroy(&wrapper->keyboard_condition);
        pthread_mutex_destroy(&wrapper->keyboard_mutex);
        free(wrapper);
        return NULL;
    }
    libssh2_session_callback_set2(
        wrapper->session,
        LIBSSH2_CALLBACK_RECV,
        (libssh2_cb_generic *)counting_receive
    );
    libssh2_session_callback_set2(
        wrapper->session,
        LIBSSH2_CALLBACK_SEND,
        (libssh2_cb_generic *)counting_send
    );
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
    ghosttea_ssh_session_keyboard_broker_cancel(session);
    clear_keyboard_answers(session);
    clear_keyboard_broker_prompt(session);
    libssh2_session_free(session->session);
    ghosttea_ssh_socket_close(session->socket_fd);
    pthread_cond_destroy(&session->keyboard_condition);
    pthread_mutex_destroy(&session->keyboard_mutex);
    memset(session, 0, sizeof(*session));
    free(session);
}

int ghosttea_ssh_session_handshake(ghosttea_ssh_session_t *session) {
    return libssh2_session_handshake(session->session, session->socket_fd);
}

int ghosttea_ssh_session_block_directions(ghosttea_ssh_session_t *session) {
    int libssh2_directions = libssh2_session_block_directions(session->session);
    int directions = 0;
    if ((libssh2_directions & LIBSSH2_SESSION_BLOCK_INBOUND) != 0) {
        directions |= GHOSTTEA_SSH_BLOCK_INBOUND;
    }
    if ((libssh2_directions & LIBSSH2_SESSION_BLOCK_OUTBOUND) != 0) {
        directions |= GHOSTTEA_SSH_BLOCK_OUTBOUND;
    }
    return directions;
}

int ghosttea_ssh_socket_wait(int socket_fd, int directions, int timeout_milliseconds) {
    short events = 0;
    if ((directions & GHOSTTEA_SSH_BLOCK_INBOUND) != 0) {
        events |= POLLIN;
    }
    if ((directions & GHOSTTEA_SSH_BLOCK_OUTBOUND) != 0) {
        events |= POLLOUT;
    }
    if (events == 0) {
        events = POLLIN | POLLOUT;
    }

    struct pollfd descriptor = {
        .fd = socket_fd,
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

int ghosttea_ssh_session_wait(ghosttea_ssh_session_t *session, int timeout_milliseconds) {
    return ghosttea_ssh_socket_wait(
        session->socket_fd,
        ghosttea_ssh_session_block_directions(session),
        timeout_milliseconds
    );
}

static int session_host_key(
    ghosttea_ssh_session_t *session,
    const char **key,
    size_t *key_length,
    int *known_key_type
) {
    size_t host_key_length = 0;
    int key_type = 0;
    const char *host_key = libssh2_session_hostkey(
        session->session,
        &host_key_length,
        &key_type
    );
    int host_key_type = LIBSSH2_KNOWNHOST_KEY_UNKNOWN;
    switch (key_type) {
    case LIBSSH2_HOSTKEY_TYPE_RSA:
        host_key_type = LIBSSH2_KNOWNHOST_KEY_SSHRSA;
        break;
    case LIBSSH2_HOSTKEY_TYPE_ED25519:
        host_key_type = LIBSSH2_KNOWNHOST_KEY_ED25519;
        break;
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_256:
        host_key_type = LIBSSH2_KNOWNHOST_KEY_ECDSA_256;
        break;
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_384:
        host_key_type = LIBSSH2_KNOWNHOST_KEY_ECDSA_384;
        break;
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_521:
        host_key_type = LIBSSH2_KNOWNHOST_KEY_ECDSA_521;
        break;
    default:
        break;
    }
    if (host_key == NULL || host_key_type == LIBSSH2_KNOWNHOST_KEY_UNKNOWN) {
        return -1;
    }
    *key = host_key;
    *key_length = host_key_length;
    *known_key_type = host_key_type;
    return 0;
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
    struct stat known_hosts_file;
    int stat_status = stat(known_hosts_path, &known_hosts_file);
    if (stat_status != 0 && errno != ENOENT) {
        libssh2_knownhost_free(known_hosts);
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }
    if (stat_status == 0
        && libssh2_knownhost_readfile(
               known_hosts,
               known_hosts_path,
               LIBSSH2_KNOWNHOST_FILE_OPENSSH
           ) < 0) {
        libssh2_knownhost_free(known_hosts);
        return LIBSSH2_KNOWNHOST_CHECK_FAILURE;
    }

    const char *key = NULL;
    size_t key_length = 0;
    int known_key_type = LIBSSH2_KNOWNHOST_KEY_UNKNOWN;
    if (session_host_key(session, &key, &key_length, &known_key_type) != 0) {
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

int ghosttea_ssh_session_store_known_host(
    ghosttea_ssh_session_t *session,
    const char *host,
    int port,
    const char *known_hosts_path
) {
    if (session == NULL || host == NULL || known_hosts_path == NULL || port <= 0) {
        return -1;
    }
    pthread_mutex_lock(&known_hosts_write_mutex);
    int result = -1;
    LIBSSH2_KNOWNHOSTS *known_hosts = libssh2_knownhost_init(session->session);
    char *stored_host = NULL;
    char *temporary_path = NULL;
    if (known_hosts == NULL) {
        goto cleanup;
    }
    struct stat existing_file;
    int stat_status = stat(known_hosts_path, &existing_file);
    if (stat_status != 0 && errno != ENOENT) {
        goto cleanup;
    }
    if (stat_status == 0
        && libssh2_knownhost_readfile(
               known_hosts,
               known_hosts_path,
               LIBSSH2_KNOWNHOST_FILE_OPENSSH
           ) < 0) {
        goto cleanup;
    }

    const char *key = NULL;
    size_t key_length = 0;
    int known_key_type = LIBSSH2_KNOWNHOST_KEY_UNKNOWN;
    if (session_host_key(session, &key, &key_length, &known_key_type) != 0) {
        goto cleanup;
    }
    struct libssh2_knownhost *match = NULL;
    int check_status = libssh2_knownhost_checkp(
        known_hosts,
        host,
        port,
        key,
        key_length,
        LIBSSH2_KNOWNHOST_TYPE_PLAIN | LIBSSH2_KNOWNHOST_KEYENC_RAW | known_key_type,
        &match
    );
    if (check_status == LIBSSH2_KNOWNHOST_CHECK_MATCH) {
        result = 0;
        goto cleanup;
    }
    if (check_status == LIBSSH2_KNOWNHOST_CHECK_MISMATCH) {
        if (match == NULL || libssh2_knownhost_del(known_hosts, match) != 0) {
            goto cleanup;
        }
    } else if (check_status != LIBSSH2_KNOWNHOST_CHECK_NOTFOUND) {
        goto cleanup;
    }

    if (port == 22) {
        stored_host = strdup(host);
    } else {
        int length = snprintf(NULL, 0, "[%s]:%d", host, port);
        if (length < 0) {
            goto cleanup;
        }
        stored_host = malloc((size_t)length + 1);
        if (stored_host != NULL) {
            snprintf(stored_host, (size_t)length + 1, "[%s]:%d", host, port);
        }
    }
    if (stored_host == NULL) {
        goto cleanup;
    }
    if (libssh2_knownhost_addc(
            known_hosts,
            stored_host,
            NULL,
            key,
            key_length,
            NULL,
            0,
            LIBSSH2_KNOWNHOST_TYPE_PLAIN | LIBSSH2_KNOWNHOST_KEYENC_RAW | known_key_type,
            NULL
        ) != 0) {
        goto cleanup;
    }

    size_t path_length = strlen(known_hosts_path);
    const char temporary_suffix[] = ".ghosttea.XXXXXX";
    temporary_path = malloc(path_length + sizeof(temporary_suffix));
    if (temporary_path == NULL) {
        goto cleanup;
    }
    snprintf(
        temporary_path,
        path_length + sizeof(temporary_suffix),
        "%s%s",
        known_hosts_path,
        temporary_suffix
    );
    int temporary_fd = mkstemp(temporary_path);
    if (temporary_fd < 0) {
        goto cleanup;
    }
    mode_t file_mode = stat_status == 0 ? existing_file.st_mode & 0777 : 0600;
    if (fchmod(temporary_fd, file_mode) != 0) {
        close(temporary_fd);
        goto cleanup;
    }
    close(temporary_fd);
    if (libssh2_knownhost_writefile(
            known_hosts,
            temporary_path,
            LIBSSH2_KNOWNHOST_FILE_OPENSSH
        ) != 0) {
        goto cleanup;
    }
    temporary_fd = open(temporary_path, O_RDONLY);
    if (temporary_fd < 0 || fsync(temporary_fd) != 0) {
        if (temporary_fd >= 0) {
            close(temporary_fd);
        }
        goto cleanup;
    }
    close(temporary_fd);
    if (rename(temporary_path, known_hosts_path) != 0) {
        goto cleanup;
    }
    free(temporary_path);
    temporary_path = NULL;
    result = 0;

cleanup:
    if (temporary_path != NULL) {
        unlink(temporary_path);
    }
    free(temporary_path);
    free(stored_host);
    if (known_hosts != NULL) {
        libssh2_knownhost_free(known_hosts);
    }
    pthread_mutex_unlock(&known_hosts_write_mutex);
    return result;
}

int ghosttea_ssh_session_host_key_sha256(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
) {
    const size_t fingerprint_length = 32;
    if (session == NULL || buffer == NULL || buffer_length < fingerprint_length) {
        return -1;
    }
    const char *fingerprint = libssh2_hostkey_hash(
        session->session,
        LIBSSH2_HOSTKEY_HASH_SHA256
    );
    if (fingerprint == NULL) {
        return -1;
    }
    memcpy(buffer, fingerprint, fingerprint_length);
    return (int)fingerprint_length;
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
    if (password == NULL) {
        return LIBSSH2_ERROR_INVAL;
    }
    return ghosttea_ssh_session_auth_password_bytes(
        session,
        username,
        (const uint8_t *)password,
        strlen(password)
    );
}

int ghosttea_ssh_session_auth_password_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const uint8_t *password,
    size_t password_length
) {
    if (session == NULL || username == NULL
        || (password == NULL && password_length > 0)) {
        return LIBSSH2_ERROR_INVAL;
    }
    size_t username_length = strlen(username);
    if (username_length > UINT_MAX || password_length > UINT_MAX) {
        return LIBSSH2_ERROR_INVAL;
    }
    if (password == NULL && password_length == 0) {
        password = (const uint8_t *)"";
    }
    return libssh2_userauth_password_ex(
        session->session,
        username,
        (unsigned int)username_length,
        (const char *)password,
        (unsigned int)password_length,
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
    return ghosttea_ssh_session_auth_public_key_passphrase_bytes(
        session,
        username,
        public_key_path,
        private_key_path,
        (const uint8_t *)passphrase,
        passphrase == NULL ? 0 : strlen(passphrase),
        passphrase == NULL ? 0 : 1
    );
}

static void clear_secret_bytes(uint8_t *bytes, size_t length) {
    volatile uint8_t *cursor = bytes;
    while (length > 0) {
        *cursor++ = 0;
        length--;
    }
}

static int copy_optional_secret(
    const uint8_t *secret,
    size_t secret_length,
    int secret_present,
    char **copy
) {
    *copy = NULL;
    if (secret_length == SIZE_MAX || (secret_present != 0 && secret_present != 1)
        || (secret_present == 0 && secret_length != 0)) {
        return LIBSSH2_ERROR_INVAL;
    }
    if (secret_present != 0 && secret_length > 0
        && (secret == NULL || memchr(secret, '\0', secret_length) != NULL)) {
        return LIBSSH2_ERROR_INVAL;
    }
    if (secret_present == 0) {
        return 0;
    }
    *copy = malloc(secret_length + 1);
    if (*copy == NULL) {
        return LIBSSH2_ERROR_ALLOC;
    }
    if (secret_length > 0) {
        memcpy(*copy, secret, secret_length);
    }
    (*copy)[secret_length] = '\0';
    return 0;
}

int ghosttea_ssh_session_auth_public_key_passphrase_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *public_key_path,
    const char *private_key_path,
    const uint8_t *passphrase,
    size_t passphrase_length,
    int passphrase_present
) {
    if (session == NULL || username == NULL || public_key_path == NULL
        || private_key_path == NULL) {
        return LIBSSH2_ERROR_INVAL;
    }
    size_t username_length = strlen(username);
    if (username_length > UINT_MAX) {
        return LIBSSH2_ERROR_INVAL;
    }
    char *terminated_passphrase = NULL;
    int copy_status = copy_optional_secret(
        passphrase,
        passphrase_length,
        passphrase_present,
        &terminated_passphrase
    );
    if (copy_status != 0) {
        return copy_status;
    }
    int status = libssh2_userauth_publickey_fromfile_ex(
        session->session,
        username,
        (unsigned int)username_length,
        public_key_path,
        private_key_path,
        terminated_passphrase
    );
    if (terminated_passphrase != NULL) {
        clear_secret_bytes((uint8_t *)terminated_passphrase, passphrase_length + 1);
        free(terminated_passphrase);
    }
    return status;
}

int ghosttea_ssh_session_auth_public_key_memory_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const uint8_t *private_key,
    size_t private_key_length,
    const uint8_t *passphrase,
    size_t passphrase_length,
    int passphrase_present
) {
    if (session == NULL || username == NULL
        || (private_key == NULL && private_key_length > 0)) {
        return LIBSSH2_ERROR_INVAL;
    }
    char *terminated_passphrase = NULL;
    int copy_status = copy_optional_secret(
        passphrase,
        passphrase_length,
        passphrase_present,
        &terminated_passphrase
    );
    if (copy_status != 0) {
        return copy_status;
    }
    const uint8_t *key_bytes = private_key;
    if (key_bytes == NULL) {
        key_bytes = (const uint8_t *)"";
    }
    int status = libssh2_userauth_publickey_frommemory(
        session->session,
        username,
        strlen(username),
        NULL,
        0,
        (const char *)key_bytes,
        private_key_length,
        terminated_passphrase
    );
    if (terminated_passphrase != NULL) {
        clear_secret_bytes((uint8_t *)terminated_passphrase, passphrase_length + 1);
        free(terminated_passphrase);
    }
    return status;
}

void ghosttea_ssh_session_reset_keyboard_answers(ghosttea_ssh_session_t *session) {
    clear_keyboard_answers(session);
}

static int add_keyboard_answer(
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

int ghosttea_ssh_session_add_keyboard_answer(
    ghosttea_ssh_session_t *session,
    const char *answer
) {
    return add_keyboard_answer(session, answer);
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

void ghosttea_ssh_session_keyboard_broker_begin(ghosttea_ssh_session_t *session) {
    pthread_mutex_lock(&session->keyboard_mutex);
    session->keyboard_broker_enabled = 1;
    session->keyboard_broker_cancelled = 0;
    session->keyboard_broker_answers_ready = 0;
    clear_keyboard_answers(session);
    clear_keyboard_broker_prompt(session);
    pthread_mutex_unlock(&session->keyboard_mutex);
}

int ghosttea_ssh_session_keyboard_broker_wait(
    ghosttea_ssh_session_t *session,
    int timeout_milliseconds
) {
    struct timespec deadline;
    if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) {
        return -1;
    }
    deadline.tv_sec += timeout_milliseconds / 1000;
    deadline.tv_nsec += (long)(timeout_milliseconds % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
    }

    pthread_mutex_lock(&session->keyboard_mutex);
    while (session->keyboard_broker_prompt_ready == 0
        && session->keyboard_broker_cancelled == 0) {
        int status = pthread_cond_timedwait(
            &session->keyboard_condition,
            &session->keyboard_mutex,
            &deadline
        );
        if (status == ETIMEDOUT) {
            pthread_mutex_unlock(&session->keyboard_mutex);
            return 0;
        }
        if (status != 0) {
            pthread_mutex_unlock(&session->keyboard_mutex);
            return -1;
        }
    }
    int result = session->keyboard_broker_cancelled == 0 ? 1 : -1;
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

static int copy_keyboard_broker_text(
    const char *text,
    char *buffer,
    size_t buffer_length
) {
    if (text == NULL) {
        return -1;
    }
    size_t length = strlen(text);
    if (length > INT_MAX) {
        return -1;
    }
    if (buffer != NULL && buffer_length > 0) {
        size_t copy_length = length < buffer_length - 1 ? length : buffer_length - 1;
        memcpy(buffer, text, copy_length);
        buffer[copy_length] = '\0';
    }
    return (int)length;
}

int ghosttea_ssh_session_keyboard_broker_name(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
) {
    pthread_mutex_lock(&session->keyboard_mutex);
    int result = copy_keyboard_broker_text(
        session->keyboard_broker_name,
        buffer,
        buffer_length
    );
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

int ghosttea_ssh_session_keyboard_broker_instruction(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
) {
    pthread_mutex_lock(&session->keyboard_mutex);
    int result = copy_keyboard_broker_text(
        session->keyboard_broker_instruction,
        buffer,
        buffer_length
    );
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

int ghosttea_ssh_session_keyboard_broker_prompt_count(ghosttea_ssh_session_t *session) {
    pthread_mutex_lock(&session->keyboard_mutex);
    int result = session->keyboard_broker_prompt_count;
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

int ghosttea_ssh_session_keyboard_broker_prompt(
    ghosttea_ssh_session_t *session,
    int index,
    char *buffer,
    size_t buffer_length,
    int *echo
) {
    pthread_mutex_lock(&session->keyboard_mutex);
    if (index < 0 || index >= session->keyboard_broker_prompt_count) {
        pthread_mutex_unlock(&session->keyboard_mutex);
        return -1;
    }
    if (echo != NULL) {
        *echo = session->keyboard_broker_echo[index];
    }
    int result = copy_keyboard_broker_text(
        session->keyboard_broker_prompts[index],
        buffer,
        buffer_length
    );
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

int ghosttea_ssh_session_keyboard_broker_add_answer(
    ghosttea_ssh_session_t *session,
    const char *answer
) {
    pthread_mutex_lock(&session->keyboard_mutex);
    int result = add_keyboard_answer(session, answer);
    pthread_mutex_unlock(&session->keyboard_mutex);
    return result;
}

int ghosttea_ssh_session_keyboard_broker_complete(ghosttea_ssh_session_t *session) {
    pthread_mutex_lock(&session->keyboard_mutex);
    if (session->keyboard_answer_count
        != (size_t)session->keyboard_broker_prompt_count) {
        pthread_mutex_unlock(&session->keyboard_mutex);
        return -1;
    }
    session->keyboard_broker_answers_ready = 1;
    session->keyboard_broker_prompt_ready = 0;
    pthread_cond_broadcast(&session->keyboard_condition);
    pthread_mutex_unlock(&session->keyboard_mutex);
    return 0;
}

void ghosttea_ssh_session_keyboard_broker_cancel(ghosttea_ssh_session_t *session) {
    pthread_mutex_lock(&session->keyboard_mutex);
    session->keyboard_broker_cancelled = 1;
    pthread_cond_broadcast(&session->keyboard_condition);
    pthread_mutex_unlock(&session->keyboard_mutex);
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

int ghosttea_ssh_session_start_command(
    ghosttea_ssh_session_t *session,
    const char *command
) {
    return libssh2_channel_exec(session->channel, command);
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

long ghosttea_ssh_session_read_stderr(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
) {
    return (long)libssh2_channel_read_stderr(
        session->channel,
        (char *)buffer,
        buffer_length
    );
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

int ghosttea_ssh_session_send_eof(ghosttea_ssh_session_t *session) {
    return libssh2_channel_send_eof(session->channel);
}

int ghosttea_ssh_session_wait_eof(ghosttea_ssh_session_t *session) {
    return libssh2_channel_wait_eof(session->channel);
}

int ghosttea_ssh_session_close_channel(ghosttea_ssh_session_t *session) {
    return libssh2_channel_close(session->channel);
}

int ghosttea_ssh_session_wait_closed(ghosttea_ssh_session_t *session) {
    return libssh2_channel_wait_closed(session->channel);
}

int ghosttea_ssh_session_exit_status(const ghosttea_ssh_session_t *session) {
    return libssh2_channel_get_exit_status(session->channel);
}

int ghosttea_ssh_session_exit_signal(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
) {
    if (session == NULL || session->channel == NULL) {
        return -1;
    }
    char *signal_name = NULL;
    size_t signal_length = 0;
    int should_copy = buffer != NULL && buffer_length > 0;
    int status = libssh2_channel_get_exit_signal(
        session->channel,
        should_copy != 0 ? &signal_name : NULL,
        &signal_length,
        NULL,
        NULL,
        NULL,
        NULL
    );
    if (status != 0) {
        return status;
    }
    if (signal_length > INT_MAX) {
        if (signal_name != NULL) {
            libssh2_free(session->session, signal_name);
        }
        return -1;
    }
    if (should_copy != 0) {
        size_t copy_length = signal_length < buffer_length - 1
            ? signal_length
            : buffer_length - 1;
        if (copy_length > 0 && signal_name != NULL) {
            memcpy(buffer, signal_name, copy_length);
        }
        buffer[copy_length] = '\0';
    }
    if (signal_name != NULL) {
        libssh2_free(session->session, signal_name);
    }
    return (int)signal_length;
}

int ghosttea_ssh_session_is_eof(const ghosttea_ssh_session_t *session) {
    return libssh2_channel_eof(session->channel);
}

unsigned long ghosttea_ssh_session_receive_window(
    const ghosttea_ssh_session_t *session,
    unsigned long *read_available,
    unsigned long *initial_window
) {
    if (session == NULL || session->channel == NULL) {
        if (read_available != NULL) {
            *read_available = 0;
        }
        if (initial_window != NULL) {
            *initial_window = 0;
        }
        return 0;
    }
    return libssh2_channel_window_read_ex(
        session->channel,
        read_available,
        initial_window
    );
}

void ghosttea_ssh_session_socket_bytes(
    const ghosttea_ssh_session_t *session,
    uint64_t *received,
    uint64_t *sent
) {
    if (received != NULL) {
        *received = session == NULL ? 0 : session->socket_bytes_received;
    }
    if (sent != NULL) {
        *sent = session == NULL ? 0 : session->socket_bytes_sent;
    }
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
