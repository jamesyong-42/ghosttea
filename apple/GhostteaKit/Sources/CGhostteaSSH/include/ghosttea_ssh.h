#ifndef GHOSTTEA_SSH_H
#define GHOSTTEA_SSH_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GHOSTTEA_SSH_EAGAIN (-37)
#define GHOSTTEA_SSH_PUBLICKEY_UNVERIFIED (-19)
#define GHOSTTEA_SSH_KNOWN_HOST_MATCH 0
#define GHOSTTEA_SSH_KNOWN_HOST_CHANGED 1
#define GHOSTTEA_SSH_KNOWN_HOST_UNKNOWN 2
#define GHOSTTEA_SSH_CONNECT_TIMEOUT (-2)
#define GHOSTTEA_SSH_CONNECT_CANCELLED (-3)
#define GHOSTTEA_SSH_BLOCK_INBOUND 1
#define GHOSTTEA_SSH_BLOCK_OUTBOUND 2

typedef struct ghosttea_ssh_session ghosttea_ssh_session_t;
typedef struct ghosttea_ssh_connector ghosttea_ssh_connector_t;

ghosttea_ssh_connector_t *ghosttea_ssh_connector_create(void);
void ghosttea_ssh_connector_cancel(ghosttea_ssh_connector_t *connector);
int ghosttea_ssh_connector_run(
    ghosttea_ssh_connector_t *connector,
    const char *host,
    const char *port,
    int timeout_milliseconds,
    char *error_buffer,
    size_t error_buffer_length
);
void ghosttea_ssh_connector_destroy(ghosttea_ssh_connector_t *connector);

void ghosttea_ssh_socket_close(int socket_fd);

ghosttea_ssh_session_t *ghosttea_ssh_session_create(int socket_fd);
void ghosttea_ssh_session_shutdown_socket(ghosttea_ssh_session_t *session);
void ghosttea_ssh_session_destroy(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_handshake(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_wait(ghosttea_ssh_session_t *session, int timeout_milliseconds);
int ghosttea_ssh_session_block_directions(ghosttea_ssh_session_t *session);
int ghosttea_ssh_socket_wait(
    int socket_fd,
    int directions,
    int timeout_milliseconds
);
int ghosttea_ssh_session_verify_known_host(
    ghosttea_ssh_session_t *session,
    const char *host,
    int port,
    const char *known_hosts_path
);
int ghosttea_ssh_session_store_known_host(
    ghosttea_ssh_session_t *session,
    const char *host,
    int port,
    const char *known_hosts_path
);
int ghosttea_ssh_session_host_key_sha256(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
);
const char *ghosttea_ssh_session_negotiated_kex(ghosttea_ssh_session_t *session);
const char *ghosttea_ssh_session_negotiated_host_key(ghosttea_ssh_session_t *session);
const char *ghosttea_ssh_session_negotiated_cipher_client_to_server(
    ghosttea_ssh_session_t *session
);
const char *ghosttea_ssh_session_negotiated_cipher_server_to_client(
    ghosttea_ssh_session_t *session
);
const char *ghosttea_ssh_session_negotiated_mac_client_to_server(
    ghosttea_ssh_session_t *session
);
const char *ghosttea_ssh_session_negotiated_mac_server_to_client(
    ghosttea_ssh_session_t *session
);
int ghosttea_ssh_session_auth_password(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *password
);
int ghosttea_ssh_session_auth_password_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const uint8_t *password,
    size_t password_length
);
int ghosttea_ssh_session_auth_public_key(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *public_key_path,
    const char *private_key_path,
    const char *passphrase
);
int ghosttea_ssh_session_auth_public_key_passphrase_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const char *public_key_path,
    const char *private_key_path,
    const uint8_t *passphrase,
    size_t passphrase_length,
    int passphrase_present
);
int ghosttea_ssh_session_auth_public_key_memory_bytes(
    ghosttea_ssh_session_t *session,
    const char *username,
    const uint8_t *private_key,
    size_t private_key_length,
    const uint8_t *passphrase,
    size_t passphrase_length,
    int passphrase_present
);
void ghosttea_ssh_session_reset_keyboard_answers(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_add_keyboard_answer(
    ghosttea_ssh_session_t *session,
    const char *answer
);
int ghosttea_ssh_session_auth_keyboard_interactive(
    ghosttea_ssh_session_t *session,
    const char *username
);
void ghosttea_ssh_session_keyboard_broker_begin(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_keyboard_broker_wait(
    ghosttea_ssh_session_t *session,
    int timeout_milliseconds
);
int ghosttea_ssh_session_keyboard_broker_name(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
);
int ghosttea_ssh_session_keyboard_broker_instruction(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
);
int ghosttea_ssh_session_keyboard_broker_prompt_count(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_keyboard_broker_prompt(
    ghosttea_ssh_session_t *session,
    int index,
    char *buffer,
    size_t buffer_length,
    int *echo
);
int ghosttea_ssh_session_keyboard_broker_add_answer(
    ghosttea_ssh_session_t *session,
    const char *answer
);
int ghosttea_ssh_session_keyboard_broker_complete(ghosttea_ssh_session_t *session);
void ghosttea_ssh_session_keyboard_broker_cancel(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_is_authenticated(const ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_keyboard_prompt_count(const ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_open_channel(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_request_pty(
    ghosttea_ssh_session_t *session,
    const char *terminal_type,
    int columns,
    int rows
);
int ghosttea_ssh_session_start_shell(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_start_command(
    ghosttea_ssh_session_t *session,
    const char *command
);
int ghosttea_ssh_session_resize(
    ghosttea_ssh_session_t *session,
    int columns,
    int rows
);
long ghosttea_ssh_session_read(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
);
long ghosttea_ssh_session_read_stderr(
    ghosttea_ssh_session_t *session,
    uint8_t *buffer,
    size_t buffer_length
);
long ghosttea_ssh_session_write(
    ghosttea_ssh_session_t *session,
    const uint8_t *buffer,
    size_t buffer_length
);
int ghosttea_ssh_session_signal_interrupt(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_send_eof(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_wait_eof(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_close_channel(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_wait_closed(ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_exit_status(const ghosttea_ssh_session_t *session);
int ghosttea_ssh_session_exit_signal(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
);
int ghosttea_ssh_session_is_eof(const ghosttea_ssh_session_t *session);
unsigned long ghosttea_ssh_session_receive_window(
    const ghosttea_ssh_session_t *session,
    unsigned long *read_available,
    unsigned long *initial_window
);
void ghosttea_ssh_session_socket_bytes(
    const ghosttea_ssh_session_t *session,
    uint64_t *received,
    uint64_t *sent
);
int ghosttea_ssh_session_last_error(
    ghosttea_ssh_session_t *session,
    char *buffer,
    size_t buffer_length
);

#ifdef __cplusplus
}
#endif

#endif
