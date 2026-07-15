#ifndef GHOSTTEA_GHOSTTY_SHIM_H
#define GHOSTTEA_GHOSTTY_SHIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct EgTerminal EgTerminal;

enum {
  EG_EFFECT_BELL = 1 << 0,
  EG_EFFECT_TITLE = 1 << 1,
  EG_EFFECT_PWD = 1 << 2,
  EG_EFFECT_CLIPBOARD = 1 << 3,
};

typedef struct {
  uint16_t cols;
  uint16_t rows;
  uint16_t cursor_x;
  uint16_t cursor_y;
  uint8_t cursor_visible;
  uint8_t cursor_style;
  uint8_t cursor_blinking;
  uint8_t full_dirty;
  uint16_t dirty_count;
  uint32_t effects;
} EgSnapshotMeta;

typedef void (*EgRowFn)(void* userdata,
                        uint16_t row,
                        const uint8_t* text,
                        size_t text_len,
                        bool dirty);

typedef struct {
  uint8_t flags;
  uint8_t fg_kind;
  uint8_t fg_r;
  uint8_t fg_g;
  uint8_t fg_b;
  uint8_t bg_kind;
  uint8_t bg_r;
  uint8_t bg_g;
  uint8_t bg_b;
} EgCellStyle;

typedef void (*EgCellFn)(void* userdata,
                         uint16_t row,
                         uint16_t column,
                         uint16_t cell_span,
                         const uint8_t* text,
                         size_t text_len,
                         const EgCellStyle* style);

EgTerminal* eg_terminal_new(uint16_t cols, uint16_t rows, size_t max_scrollback);
void eg_terminal_free(EgTerminal* terminal);
void eg_terminal_write(EgTerminal* terminal, const uint8_t* data, size_t len);
int eg_terminal_resize(EgTerminal* terminal, uint16_t cols, uint16_t rows);
int eg_terminal_set_colors(EgTerminal* terminal,
                           uint8_t fg_r, uint8_t fg_g, uint8_t fg_b,
                           uint8_t bg_r, uint8_t bg_g, uint8_t bg_b,
                           uint8_t cursor_r, uint8_t cursor_g, uint8_t cursor_b);
void eg_terminal_scroll(EgTerminal* terminal, intptr_t rows);
bool eg_terminal_mouse_tracking(EgTerminal* terminal);
bool eg_terminal_alternate_scroll(EgTerminal* terminal);
int eg_terminal_snapshot(EgTerminal* terminal,
                         EgSnapshotMeta* meta,
                         EgRowFn row_fn,
                         EgCellFn cell_fn,
                         void* userdata);
size_t eg_terminal_take_response(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_title(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_pwd(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_take_clipboard(EgTerminal* terminal, uint8_t* out, size_t cap);
int eg_terminal_encode_key(EgTerminal* terminal,
                           const uint8_t* code,
                           size_t code_len,
                           const uint8_t* text,
                           size_t text_len,
                           uint16_t mods,
                           uint8_t action,
                           uint8_t* out,
                           size_t cap,
                           size_t* out_len);
int eg_terminal_encode_mouse(EgTerminal* terminal,
                             uint8_t action,
                             uint8_t button,
                             uint16_t mods,
                             float x,
                             float y,
                             uint32_t screen_width,
                             uint32_t screen_height,
                             uint32_t cell_width,
                             uint32_t cell_height,
                             uint32_t padding_left,
                             uint32_t padding_top,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);
int eg_terminal_encode_focus(EgTerminal* terminal,
                             bool focused,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);
int eg_terminal_encode_paste(EgTerminal* terminal,
                             const uint8_t* data,
                             size_t data_len,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);

#endif
