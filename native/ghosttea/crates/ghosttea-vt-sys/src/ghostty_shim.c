#include "ghostty_shim.h"

#include <ghostty/vt.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uint8_t* ptr;
  size_t len;
  size_t cap;
} EgBuffer;

struct EgTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  EgBuffer response;
  EgBuffer row;
  EgBuffer clipboard;
  bool mouse_pressed;
  uint32_t effects;
};

struct EgTrackedSelection {
  GhosttyTrackedGridRef start;
  GhosttyTrackedGridRef end;
  GhosttyTerminalScreen screen;
  bool rectangle;
};

int eg_terminal_set_colors(EgTerminal* state,
                           uint8_t fg_r, uint8_t fg_g, uint8_t fg_b,
                           uint8_t bg_r, uint8_t bg_g, uint8_t bg_b,
                           uint8_t cursor_r, uint8_t cursor_g, uint8_t cursor_b) {
  if (state == NULL) return GHOSTTY_INVALID_VALUE;
  GhosttyColorRgb foreground = {fg_r, fg_g, fg_b};
  GhosttyColorRgb background = {bg_r, bg_g, bg_b};
  GhosttyColorRgb cursor = {cursor_r, cursor_g, cursor_b};
  GhosttyResult result = ghostty_terminal_set(
      state->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(
      state->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_terminal_set(
      state->terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
}

int eg_terminal_set_palette(EgTerminal* state,
                            const uint8_t* indices,
                            const uint8_t* colors,
                            size_t len) {
  if (state == NULL || (len != 0 && (indices == NULL || colors == NULL)))
    return GHOSTTY_INVALID_VALUE;
  GhosttyColorRgb palette[256];
  ghostty_color_palette_default(palette);
  for (size_t i = 0; i < len; i++) {
    const size_t color_offset = i * 3;
    palette[indices[i]] = (GhosttyColorRgb){
        colors[color_offset], colors[color_offset + 1], colors[color_offset + 2]};
  }
  return ghostty_terminal_set(
      state->terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palette);
}

enum { EG_MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024 };

static bool eg_buffer_reserve(EgBuffer* buffer, size_t required) {
  if (required <= buffer->cap) return true;
  size_t capacity = buffer->cap == 0 ? 128 : buffer->cap;
  while (capacity < required) {
    if (capacity > SIZE_MAX / 2) return false;
    capacity *= 2;
  }
  uint8_t* next = realloc(buffer->ptr, capacity);
  if (next == NULL) return false;
  buffer->ptr = next;
  buffer->cap = capacity;
  return true;
}

static bool eg_buffer_append(EgBuffer* buffer, const uint8_t* data, size_t len) {
  if (len > SIZE_MAX - buffer->len) return false;
  if (!eg_buffer_reserve(buffer, buffer->len + len)) return false;
  memcpy(buffer->ptr + buffer->len, data, len);
  buffer->len += len;
  return true;
}

static void eg_write_pty(GhosttyTerminal terminal,
                         void* userdata,
                         const uint8_t* data,
                         size_t len) {
  (void)terminal;
  EgTerminal* state = userdata;
  (void)eg_buffer_append(&state->response, data, len);
}

static void eg_bell(GhosttyTerminal terminal, void* userdata) {
  (void)terminal;
  ((EgTerminal*)userdata)->effects |= EG_EFFECT_BELL;
}

static void eg_title_changed(GhosttyTerminal terminal, void* userdata) {
  (void)terminal;
  ((EgTerminal*)userdata)->effects |= EG_EFFECT_TITLE;
}

static void eg_pwd_changed(GhosttyTerminal terminal, void* userdata) {
  (void)terminal;
  ((EgTerminal*)userdata)->effects |= EG_EFFECT_PWD;
}

static GhosttyClipboardWriteResult eg_clipboard_write(
    GhosttyTerminal terminal,
    void* userdata,
    const GhosttyClipboardWrite* write) {
  (void)terminal;
  EgTerminal* state = userdata;
  if (write == NULL || write->contents_len == 0) {
    state->clipboard.len = 0;
    state->effects |= EG_EFFECT_CLIPBOARD;
    return GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS;
  }
  const GhosttyClipboardContent* selected = NULL;
  for (size_t index = 0; index < write->contents_len; index++) {
    const GhosttyClipboardContent* content = &write->contents[index];
    if (content->mime.len >= 10 &&
        memcmp(content->mime.ptr, "text/plain", 10) == 0) {
      selected = content;
      break;
    }
  }
  if (selected == NULL) return GHOSTTY_CLIPBOARD_WRITE_RESULT_UNSUPPORTED;
  if (selected->data.len > EG_MAX_CLIPBOARD_BYTES)
    return GHOSTTY_CLIPBOARD_WRITE_RESULT_INVALID_DATA;
  state->clipboard.len = 0;
  if (!eg_buffer_append(&state->clipboard, selected->data.ptr, selected->data.len))
    return GHOSTTY_CLIPBOARD_WRITE_RESULT_IO_ERROR;
  state->effects |= EG_EFFECT_CLIPBOARD;
  return GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS;
}

EgTerminal* eg_terminal_new(uint16_t cols, uint16_t rows, size_t max_scrollback) {
  EgTerminal* state = calloc(1, sizeof(EgTerminal));
  if (state == NULL) return NULL;
  GhosttyTerminalOptions options = {
      .cols = cols,
      .rows = rows,
      .max_scrollback = max_scrollback,
  };
  if (ghostty_terminal_new(NULL, &state->terminal, options) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_render_state_new(NULL, &state->render) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_render_state_row_iterator_new(NULL, &state->rows) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_render_state_row_cells_new(NULL, &state->cells) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_key_encoder_new(NULL, &state->key_encoder) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_key_event_new(NULL, &state->key_event) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_mouse_encoder_new(NULL, &state->mouse_encoder) != GHOSTTY_SUCCESS) goto fail;
  if (ghostty_mouse_event_new(NULL, &state->mouse_event) != GHOSTTY_SUCCESS) goto fail;

  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, state);
  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, (const void*)eg_write_pty);
  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_BELL, (const void*)eg_bell);
  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_TITLE_CHANGED, (const void*)eg_title_changed);
  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_PWD_CHANGED, (const void*)eg_pwd_changed);
  ghostty_terminal_set(state->terminal, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE, (const void*)eg_clipboard_write);
  if (eg_terminal_set_colors(
          state,
          255, 255, 255,
          40, 44, 52,
          255, 255, 255) != GHOSTTY_SUCCESS) goto fail;
  // A blinking cursor is this terminal's default, which takes two writes for
  // two different questions. The mode is the cursor's state right now, before
  // any program has expressed a preference. The option is what "default" means
  // later: libghostty resolves both `CSI 0 q` and a terminal reset against
  // DEFAULT_CURSOR_BLINK, whose built-in value is false. Setting only the mode
  // made the default survive exactly until the first program asked for the
  // default cursor — a steady cursor for the rest of the session, and one that
  // is only visible in programs that show the real cursor rather than drawing
  // their own.
  bool default_cursor_blink = true;
  ghostty_terminal_set(
      state->terminal, GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_BLINK, &default_cursor_blink);
  ghostty_terminal_mode_set(state->terminal, GHOSTTY_MODE_CURSOR_BLINKING, true);
  return state;

fail:
  eg_terminal_free(state);
  return NULL;
}

void eg_terminal_free(EgTerminal* state) {
  if (state == NULL) return;
  ghostty_mouse_event_free(state->mouse_event);
  ghostty_mouse_encoder_free(state->mouse_encoder);
  ghostty_key_event_free(state->key_event);
  ghostty_key_encoder_free(state->key_encoder);
  ghostty_render_state_row_cells_free(state->cells);
  ghostty_render_state_row_iterator_free(state->rows);
  ghostty_render_state_free(state->render);
  ghostty_terminal_free(state->terminal);
  free(state->response.ptr);
  free(state->row.ptr);
  free(state->clipboard.ptr);
  free(state);
}

void eg_terminal_write(EgTerminal* state, const uint8_t* data, size_t len) {
  if (state == NULL || (data == NULL && len != 0)) return;
  ghostty_terminal_vt_write(state->terminal, data, len);
}

int eg_terminal_encode_paste(EgTerminal* state,
                             const uint8_t* data,
                             size_t data_len,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len) {
  if (state == NULL || out_len == NULL || (data == NULL && data_len != 0) ||
      (out == NULL && cap != 0)) return GHOSTTY_INVALID_VALUE;
  bool bracketed = false;
  GhosttyResult result = ghostty_terminal_mode_get(
      state->terminal, GHOSTTY_MODE_BRACKETED_PASTE, &bracketed);
  if (result != GHOSTTY_SUCCESS) return result;
  char* copy = data_len == 0 ? NULL : malloc(data_len);
  if (data_len != 0 && copy == NULL) return GHOSTTY_OUT_OF_MEMORY;
  if (data_len != 0) memcpy(copy, data, data_len);
  result = ghostty_paste_encode(copy, data_len, bracketed, (char*)out, cap, out_len);
  free(copy);
  return result;
}

int eg_terminal_resize(EgTerminal* state, uint16_t cols, uint16_t rows) {
  if (state == NULL) return GHOSTTY_INVALID_VALUE;
  return ghostty_terminal_resize(state->terminal, cols, rows, 8, 19);
}

void eg_terminal_scroll(EgTerminal* state, intptr_t rows) {
  if (state == NULL || rows == 0) return;
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
      .value.delta = rows,
  };
  ghostty_terminal_scroll_viewport(state->terminal, behavior);
}

void eg_terminal_scroll_to(EgTerminal* state, size_t row) {
  if (state == NULL) return;
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_ROW,
      .value.row = row,
  };
  ghostty_terminal_scroll_viewport(state->terminal, behavior);
}

int eg_terminal_compress_scrollback_full(EgTerminal* state) {
  if (state == NULL) return -1;
  GhosttyTerminalCompressionResult compression =
      GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED;
  if (ghostty_terminal_compress(
          state->terminal,
          GHOSTTY_TERMINAL_COMPRESSION_MODE_FULL,
          &compression) != GHOSTTY_SUCCESS) {
    return -1;
  }
  return compression == GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED ? 0 : 1;
}

bool eg_terminal_scrollbar(EgTerminal* state, EgScrollbar* scrollbar) {
  if (state == NULL || scrollbar == NULL) return false;
  GhosttyTerminalScrollbar value = {0};
  if (ghostty_terminal_get(
          state->terminal, GHOSTTY_TERMINAL_DATA_SCROLLBAR, &value) != GHOSTTY_SUCCESS)
    return false;
  scrollbar->total = value.total;
  scrollbar->offset = value.offset;
  scrollbar->len = value.len;
  return true;
}

bool eg_terminal_mouse_tracking(EgTerminal* state) {
  bool tracking = false;
  if (state != NULL)
    ghostty_terminal_get(state->terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &tracking);
  return tracking;
}

bool eg_terminal_alternate_scroll(EgTerminal* state) {
  if (state == NULL) return false;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  bool alternate_scroll = false;
  if (ghostty_terminal_get(
          state->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS)
    return false;
  if (ghostty_terminal_mode_get(
          state->terminal, GHOSTTY_MODE_ALT_SCROLL, &alternate_scroll) != GHOSTTY_SUCCESS)
    return false;
  return screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE && alternate_scroll;
}

EgTrackedSelection* eg_terminal_track_selection(EgTerminal* state,
                                                uint16_t start_column,
                                                uint32_t start_row,
                                                uint16_t end_column,
                                                uint32_t end_row,
                                                bool select_all) {
  if (state == NULL) return NULL;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  if (ghostty_terminal_get(
          state->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS)
    return NULL;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyResult result;
  if (select_all) {
    result = ghostty_terminal_select_all(state->terminal, &selection);
  } else {
    GhosttyPoint start = {
        .tag = GHOSTTY_POINT_TAG_SCREEN,
        .value.coordinate = {.x = start_column, .y = start_row},
    };
    GhosttyPoint end = {
        .tag = GHOSTTY_POINT_TAG_SCREEN,
        .value.coordinate = {.x = end_column, .y = end_row},
    };
    result = ghostty_terminal_grid_ref(state->terminal, start, &selection.start);
    if (result == GHOSTTY_SUCCESS)
      result = ghostty_terminal_grid_ref(state->terminal, end, &selection.end);
  }
  if (result != GHOSTTY_SUCCESS) return NULL;

  // Convert both untracked snapshot refs before creating either tracked ref.
  // Snapshot refs are short-lived, while the coordinates remain valid for the
  // remainder of this serialized terminal operation.
  GhosttyPointCoordinate start_coordinate = {0};
  GhosttyPointCoordinate end_coordinate = {0};
  result = ghostty_terminal_point_from_grid_ref(
      state->terminal, &selection.start, GHOSTTY_POINT_TAG_SCREEN,
      &start_coordinate);
  if (result != GHOSTTY_SUCCESS) return NULL;
  result = ghostty_terminal_point_from_grid_ref(
      state->terminal, &selection.end, GHOSTTY_POINT_TAG_SCREEN,
      &end_coordinate);
  if (result != GHOSTTY_SUCCESS) return NULL;

  EgTrackedSelection* tracked = calloc(1, sizeof(*tracked));
  if (tracked == NULL) return NULL;
  GhosttyPoint start = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value.coordinate = start_coordinate,
  };
  GhosttyPoint end = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value.coordinate = end_coordinate,
  };
  result = ghostty_terminal_grid_ref_track(
      state->terminal, start, &tracked->start);
  if (result == GHOSTTY_SUCCESS)
    result = ghostty_terminal_grid_ref_track(
        state->terminal, end, &tracked->end);
  if (result != GHOSTTY_SUCCESS) {
    ghostty_tracked_grid_ref_free(tracked->start);
    ghostty_tracked_grid_ref_free(tracked->end);
    free(tracked);
    return NULL;
  }
  tracked->screen = screen;
  tracked->rectangle = selection.rectangle;
  return tracked;
}

void eg_tracked_selection_free(EgTrackedSelection* selection) {
  if (selection == NULL) return;
  ghostty_tracked_grid_ref_free(selection->start);
  ghostty_tracked_grid_ref_free(selection->end);
  free(selection);
}

bool eg_terminal_tracked_selection_points(
    EgTerminal* state,
    const EgTrackedSelection* selection,
    EgSelection* out) {
  if (state == NULL || selection == NULL || out == NULL) return false;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  if (ghostty_terminal_get(
          state->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS ||
      screen != selection->screen)
    return false;
  GhosttyPointCoordinate start = {0};
  GhosttyPointCoordinate end = {0};
  if (ghostty_tracked_grid_ref_point(
          selection->start, GHOSTTY_POINT_TAG_SCREEN, &start) != GHOSTTY_SUCCESS)
    return false;
  if (ghostty_tracked_grid_ref_point(
          selection->end, GHOSTTY_POINT_TAG_SCREEN, &end) != GHOSTTY_SUCCESS)
    return false;
  out->start_column = start.x;
  out->start_row = start.y;
  out->end_column = end.x;
  out->end_row = end.y;
  return true;
}

size_t eg_terminal_tracked_selection_text(
    EgTerminal* state,
    const EgTrackedSelection* tracked,
    uint8_t* out,
    size_t cap) {
  if (state == NULL || tracked == NULL) return SIZE_MAX;
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  if (ghostty_terminal_get(
          state->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen) != GHOSTTY_SUCCESS)
    return SIZE_MAX;
  if (screen != tracked->screen) return 0;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  GhosttyResult result = ghostty_tracked_grid_ref_snapshot(
      tracked->start, &selection.start);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return SIZE_MAX;
  result = ghostty_tracked_grid_ref_snapshot(tracked->end, &selection.end);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return SIZE_MAX;
  selection.rectangle = tracked->rectangle;

  GhosttyTerminalSelectionFormatOptions options =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSelectionFormatOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.unwrap = true;
  options.trim = true;
  options.selection = &selection;
  size_t written = 0;
  result = ghostty_terminal_selection_format_buf(
      state->terminal, options, out, cap, &written);
  if (result == GHOSTTY_SUCCESS || result == GHOSTTY_OUT_OF_SPACE) return written;
  if (result == GHOSTTY_NO_VALUE) return 0;
  return SIZE_MAX;
}

size_t eg_terminal_selection_text(EgTerminal* state,
                                  uint16_t start_column,
                                  uint32_t start_row,
                                  uint16_t end_column,
                                  uint32_t end_row,
                                  bool select_all,
                                  uint8_t* out,
                                  size_t cap) {
  EgTrackedSelection* selection = eg_terminal_track_selection(
      state, start_column, start_row, end_column, end_row, select_all);
  if (selection == NULL) return SIZE_MAX;
  size_t written = eg_terminal_tracked_selection_text(
      state, selection, out, cap);
  eg_tracked_selection_free(selection);
  return written;
}

static void eg_cell_style(GhosttyRenderStateRowCells cells, EgCellStyle* compact) {
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  memset(compact, 0, sizeof(*compact));
  ghostty_render_state_row_cells_get(
      cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
  compact->flags = (style.bold ? 1 : 0) |
                   (style.italic ? 2 : 0) |
                   (style.faint ? 4 : 0) |
                   (style.inverse ? 8 : 0) |
                   (style.invisible ? 16 : 0) |
                   (style.strikethrough ? 32 : 0) |
                   (style.underline ? 64 : 0);
  GhosttyColorRgb color = {0};
  if (ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &color) == GHOSTTY_SUCCESS) {
    compact->fg_kind = 1;
    compact->fg_r = color.r; compact->fg_g = color.g; compact->fg_b = color.b;
  }
  if (ghostty_render_state_row_cells_get(
          cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &color) == GHOSTTY_SUCCESS) {
    compact->bg_kind = 1;
    compact->bg_r = color.r; compact->bg_g = color.g; compact->bg_b = color.b;
  }
}

int eg_terminal_snapshot(EgTerminal* state,
                         EgSnapshotMeta* meta,
                         EgRowFn row_fn,
                         EgCellFn cell_fn,
                         void* userdata) {
  if (state == NULL || meta == NULL || row_fn == NULL || cell_fn == NULL) return GHOSTTY_INVALID_VALUE;
  GhosttyResult result = ghostty_render_state_update(state->render, state->terminal);
  if (result != GHOSTTY_SUCCESS) return result;

  GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_COLS, &meta->cols);
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_ROWS, &meta->rows);
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &meta->cursor_visible);
  GhosttyRenderStateCursorVisualStyle cursor_style = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE, &cursor_style);
  meta->cursor_style = (uint8_t)cursor_style;
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING, &meta->cursor_blinking);
  // Two independent questions: CURSOR_VISIBLE answers "do the terminal modes
  // show a cursor" (DECTCEM), while CURSOR_VIEWPORT_HAS_VALUE answers "is it
  // inside the rows we are about to hand over". Scrolling into the scrollback
  // leaves the first true and the second false, and the position values are
  // documented as undefined in that case. Reporting mode-visible with a zeroed
  // position parks a cursor in the top-left corner of the viewport for as long
  // as the user stays scrolled up, so a cursor is drawable only when it is both
  // enabled and actually on screen.
  bool cursor_has_value = false;
  ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE, &cursor_has_value);
  meta->cursor_x = 0;
  meta->cursor_y = 0;
  if (cursor_has_value) {
    ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X, &meta->cursor_x);
    ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y, &meta->cursor_y);
  } else {
    meta->cursor_visible = 0;
  }
  meta->full_dirty = dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL;
  meta->dirty_count = 0;
  meta->effects = state->effects;
  state->effects = 0;

  result = ghostty_render_state_get(state->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &state->rows);
  if (result != GHOSTTY_SUCCESS) return result;

  uint16_t row_index = 0;
  while (ghostty_render_state_row_iterator_next(state->rows)) {
    bool row_dirty = false;
    ghostty_render_state_row_get(state->rows, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &row_dirty);
    if (row_dirty && meta->dirty_count != UINT16_MAX) meta->dirty_count += 1;
    if (!meta->full_dirty && !row_dirty) {
      row_fn(userdata, row_index, NULL, 0, false);
      row_index += 1;
      continue;
    }
    result = ghostty_render_state_row_get(state->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &state->cells);
    if (result != GHOSTTY_SUCCESS) return result;
    state->row.len = 0;
    uint16_t column = 0;

    while (ghostty_render_state_row_cells_next(state->cells)) {
      uint8_t stack[64];
      GhosttyBuffer grapheme = {.ptr = stack, .cap = sizeof(stack), .len = 0};
      result = ghostty_render_state_row_cells_get(
          state->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme);
      bool already_appended = false;
      if (result == GHOSTTY_OUT_OF_SPACE) {
        if (!eg_buffer_reserve(&state->row, state->row.len + grapheme.len)) return GHOSTTY_OUT_OF_MEMORY;
        grapheme.ptr = state->row.ptr + state->row.len;
        grapheme.cap = state->row.cap - state->row.len;
        result = ghostty_render_state_row_cells_get(
            state->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme);
        if (result != GHOSTTY_SUCCESS) return result;
        state->row.len += grapheme.len;
        already_appended = true;
      }
      if (result != GHOSTTY_SUCCESS) return result;

      GhosttyCell raw = 0;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      result = ghostty_render_state_row_cells_get(
          state->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW, &raw);
      if (result != GHOSTTY_SUCCESS) return result;
      result = ghostty_cell_get(raw, GHOSTTY_CELL_DATA_WIDE, &wide);
      if (result != GHOSTTY_SUCCESS) return result;

      if (grapheme.len == 0) {
        if (wide == GHOSTTY_CELL_WIDE_NARROW) {
          const uint8_t space = ' ';
          EgCellStyle compact;
          eg_cell_style(state->cells, &compact);
          cell_fn(userdata, row_index, column, 1, &space, 1, &compact);
          if (!eg_buffer_append(&state->row, &space, 1)) return GHOSTTY_OUT_OF_MEMORY;
        }
      } else {
        EgCellStyle compact;
        eg_cell_style(state->cells, &compact);
        uint16_t span = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
        cell_fn(userdata, row_index, column, span, grapheme.ptr, grapheme.len, &compact);
        if (!already_appended && !eg_buffer_append(&state->row, grapheme.ptr, grapheme.len))
          return GHOSTTY_OUT_OF_MEMORY;
      }
      column += 1;
    }

    while (state->row.len > 0 && state->row.ptr[state->row.len - 1] == ' ') state->row.len -= 1;
    row_fn(userdata, row_index, state->row.ptr, state->row.len, row_dirty);
    bool clean = false;
    ghostty_render_state_row_set(state->rows, GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
    row_index += 1;
  }

  GhosttyRenderStateDirty clean = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_set(state->render, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &clean);
  return GHOSTTY_SUCCESS;
}

size_t eg_terminal_take_response(EgTerminal* state, uint8_t* out, size_t cap) {
  if (state == NULL) return 0;
  size_t required = state->response.len;
  if (out == NULL || cap < required) return required;
  memcpy(out, state->response.ptr, required);
  state->response.len = 0;
  return required;
}

static size_t eg_terminal_string(EgTerminal* state,
                                 GhosttyTerminalData kind,
                                 uint8_t* out,
                                 size_t cap) {
  if (state == NULL) return 0;
  GhosttyString value = {0};
  if (ghostty_terminal_get(state->terminal, kind, &value) != GHOSTTY_SUCCESS) return 0;
  if (out != NULL && cap >= value.len) memcpy(out, value.ptr, value.len);
  return value.len;
}

size_t eg_terminal_title(EgTerminal* state, uint8_t* out, size_t cap) {
  return eg_terminal_string(state, GHOSTTY_TERMINAL_DATA_TITLE, out, cap);
}

size_t eg_terminal_pwd(EgTerminal* state, uint8_t* out, size_t cap) {
  return eg_terminal_string(state, GHOSTTY_TERMINAL_DATA_PWD, out, cap);
}

size_t eg_terminal_take_clipboard(EgTerminal* state, uint8_t* out, size_t cap) {
  if (state == NULL) return 0;
  size_t required = state->clipboard.len;
  if (out == NULL || cap < required) return required;
  if (required != 0) memcpy(out, state->clipboard.ptr, required);
  state->clipboard.len = 0;
  return required;
}

static bool eg_code_is(const uint8_t* code, size_t code_len, const char* expected) {
  size_t expected_len = strlen(expected);
  return code_len == expected_len && memcmp(code, expected, code_len) == 0;
}

// Decodes `text` when it is exactly one UTF-8 scalar, else returns 0. Ghostty
// compares the produced text against the unshifted codepoint one scalar at a
// time, so a multi-scalar string (IME preedit, an emoji cluster) is not a
// shifted-key translation and must not be treated as one.
static uint32_t eg_single_codepoint(const uint8_t* text, size_t text_len) {
  if (text == NULL || text_len == 0) return 0;
  uint32_t codepoint;
  size_t width;
  if ((text[0] & 0x80) == 0) {
    codepoint = text[0];
    width = 1;
  } else if ((text[0] & 0xE0) == 0xC0) {
    codepoint = (uint32_t)(text[0] & 0x1F);
    width = 2;
  } else if ((text[0] & 0xF0) == 0xE0) {
    codepoint = (uint32_t)(text[0] & 0x0F);
    width = 3;
  } else if ((text[0] & 0xF8) == 0xF0) {
    codepoint = (uint32_t)(text[0] & 0x07);
    width = 4;
  } else {
    return 0;
  }
  if (width != text_len) return 0;
  for (size_t index = 1; index < width; index++) {
    if ((text[index] & 0xC0) != 0x80) return 0;
    codepoint = (codepoint << 6) | (uint32_t)(text[index] & 0x3F);
  }
  return codepoint;
}

// Which modifiers the keyboard layout spent to produce `text`, as opposed to
// which ones the application should still be told about.
//
// Ghostty's encoders send text verbatim only when `mods.unset(consumed_mods)`
// is empty, so reporting nothing consumed makes every shifted key look like a
// modified keypress. Under the Kitty protocol that turns Shift+/ into
// `CSI 47;2u` — keycode `/` plus a shift modifier — and a client that cannot
// map a keycode back through the layout inserts `/`. Shift is consumed exactly
// when the layout translated it into different text, which is the same test
// Ghostty's own apprts perform against the platform keymap.
static GhosttyMods eg_consumed_mods(const uint8_t* text,
                                    size_t text_len,
                                    uint32_t unshifted_codepoint,
                                    uint16_t mods) {
  if ((mods & GHOSTTY_MODS_SHIFT) == 0) return 0;
  uint32_t produced = eg_single_codepoint(text, text_len);
  if (produced == 0 || unshifted_codepoint == 0 || produced == unshifted_codepoint) return 0;
  return GHOSTTY_MODS_SHIFT;
}

static GhosttyKey eg_key_from_code(const uint8_t* code, size_t code_len) {
  if (code == NULL) return GHOSTTY_KEY_UNIDENTIFIED;
  if (code_len == 4 && memcmp(code, "Key", 3) == 0 && code[3] >= 'A' && code[3] <= 'Z')
    return (GhosttyKey)(GHOSTTY_KEY_A + code[3] - 'A');
  if (code_len == 6 && memcmp(code, "Digit", 5) == 0 && code[5] >= '0' && code[5] <= '9')
    return (GhosttyKey)(GHOSTTY_KEY_DIGIT_0 + code[5] - '0');

#define EG_KEY(name, value) if (eg_code_is(code, code_len, name)) return value
  EG_KEY("Backquote", GHOSTTY_KEY_BACKQUOTE);
  EG_KEY("Backslash", GHOSTTY_KEY_BACKSLASH);
  EG_KEY("BracketLeft", GHOSTTY_KEY_BRACKET_LEFT);
  EG_KEY("BracketRight", GHOSTTY_KEY_BRACKET_RIGHT);
  EG_KEY("Comma", GHOSTTY_KEY_COMMA);
  EG_KEY("Equal", GHOSTTY_KEY_EQUAL);
  EG_KEY("Minus", GHOSTTY_KEY_MINUS);
  EG_KEY("Period", GHOSTTY_KEY_PERIOD);
  EG_KEY("Quote", GHOSTTY_KEY_QUOTE);
  EG_KEY("Semicolon", GHOSTTY_KEY_SEMICOLON);
  EG_KEY("Slash", GHOSTTY_KEY_SLASH);
  EG_KEY("Backspace", GHOSTTY_KEY_BACKSPACE);
  EG_KEY("Enter", GHOSTTY_KEY_ENTER);
  EG_KEY("Space", GHOSTTY_KEY_SPACE);
  EG_KEY("Tab", GHOSTTY_KEY_TAB);
  EG_KEY("Delete", GHOSTTY_KEY_DELETE);
  EG_KEY("End", GHOSTTY_KEY_END);
  EG_KEY("Home", GHOSTTY_KEY_HOME);
  EG_KEY("Insert", GHOSTTY_KEY_INSERT);
  EG_KEY("PageDown", GHOSTTY_KEY_PAGE_DOWN);
  EG_KEY("PageUp", GHOSTTY_KEY_PAGE_UP);
  EG_KEY("ArrowDown", GHOSTTY_KEY_ARROW_DOWN);
  EG_KEY("ArrowLeft", GHOSTTY_KEY_ARROW_LEFT);
  EG_KEY("ArrowRight", GHOSTTY_KEY_ARROW_RIGHT);
  EG_KEY("ArrowUp", GHOSTTY_KEY_ARROW_UP);
  EG_KEY("Escape", GHOSTTY_KEY_ESCAPE);
  if (code_len >= 2 && code_len <= 3 && code[0] == 'F') {
    unsigned number = 0;
    for (size_t index = 1; index < code_len; index++) {
      if (code[index] < '0' || code[index] > '9') return GHOSTTY_KEY_UNIDENTIFIED;
      number = number * 10 + (unsigned)(code[index] - '0');
    }
    if (number >= 1 && number <= 25) return (GhosttyKey)(GHOSTTY_KEY_F1 + number - 1);
  }
#undef EG_KEY
  return GHOSTTY_KEY_UNIDENTIFIED;
}

int eg_terminal_encode_key(EgTerminal* state,
                           const uint8_t* code,
                           size_t code_len,
                           const uint8_t* text,
                           size_t text_len,
                           uint32_t unshifted_codepoint,
                           uint16_t mods,
                           uint8_t action,
                           uint8_t* out,
                           size_t cap,
                           size_t* out_len) {
  if (state == NULL || out_len == NULL || action > GHOSTTY_KEY_ACTION_REPEAT ||
      unshifted_codepoint > 0x10FFFF ||
      (unshifted_codepoint >= 0xD800 && unshifted_codepoint <= 0xDFFF))
    return GHOSTTY_INVALID_VALUE;
  if (action == GHOSTTY_KEY_ACTION_RELEASE) {
    GhosttyKittyKeyFlags flags = GHOSTTY_KITTY_KEY_DISABLED;
    ghostty_terminal_get(
        state->terminal, GHOSTTY_TERMINAL_DATA_KITTY_KEYBOARD_FLAGS, &flags);
    if ((flags & GHOSTTY_KITTY_KEY_REPORT_EVENTS) == 0) {
      *out_len = 0;
      return GHOSTTY_SUCCESS;
    }
  }
  ghostty_key_encoder_setopt_from_terminal(state->key_encoder, state->terminal);
  GhosttyOptionAsAlt option_as_alt = GHOSTTY_OPTION_AS_ALT_TRUE;
  ghostty_key_encoder_setopt(
      state->key_encoder, GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT, &option_as_alt);
  ghostty_key_event_set_action(state->key_event, (GhosttyKeyAction)action);
  ghostty_key_event_set_key(state->key_event, eg_key_from_code(code, code_len));
  ghostty_key_event_set_mods(state->key_event, mods);
  ghostty_key_event_set_consumed_mods(
      state->key_event,
      action == GHOSTTY_KEY_ACTION_RELEASE
          ? 0
          : eg_consumed_mods(text, text_len, unshifted_codepoint, mods));
  ghostty_key_event_set_composing(state->key_event, false);
  ghostty_key_event_set_unshifted_codepoint(state->key_event, unshifted_codepoint);
  ghostty_key_event_set_utf8(
      state->key_event,
      action == GHOSTTY_KEY_ACTION_RELEASE || text_len == 0 ? NULL : (const char*)text,
      action == GHOSTTY_KEY_ACTION_RELEASE ? 0 : text_len);
  return ghostty_key_encoder_encode(
      state->key_encoder, state->key_event, (char*)out, cap, out_len);
}

int eg_terminal_encode_mouse(EgTerminal* state,
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
                             size_t* out_len) {
  if (state == NULL || out_len == NULL || action > GHOSTTY_MOUSE_ACTION_MOTION ||
      button > GHOSTTY_MOUSE_BUTTON_ELEVEN || cell_width == 0 || cell_height == 0)
    return GHOSTTY_INVALID_VALUE;
  ghostty_mouse_encoder_setopt_from_terminal(state->mouse_encoder, state->terminal);
  GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
  size.screen_width = screen_width;
  size.screen_height = screen_height;
  size.cell_width = cell_width;
  size.cell_height = cell_height;
  size.padding_left = padding_left;
  size.padding_top = padding_top;
  ghostty_mouse_encoder_setopt(state->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);

  bool pressed_during_event = state->mouse_pressed || action == GHOSTTY_MOUSE_ACTION_PRESS;
  ghostty_mouse_encoder_setopt(
      state->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED, &pressed_during_event);
  ghostty_mouse_event_set_action(state->mouse_event, (GhosttyMouseAction)action);
  if (button == GHOSTTY_MOUSE_BUTTON_UNKNOWN)
    ghostty_mouse_event_clear_button(state->mouse_event);
  else
    ghostty_mouse_event_set_button(state->mouse_event, (GhosttyMouseButton)button);
  ghostty_mouse_event_set_mods(state->mouse_event, mods);
  ghostty_mouse_event_set_position(
      state->mouse_event, (GhosttyMousePosition){.x = x, .y = y});
  GhosttyResult result = ghostty_mouse_encoder_encode(
      state->mouse_encoder, state->mouse_event, (char*)out, cap, out_len);
  if (action == GHOSTTY_MOUSE_ACTION_PRESS &&
      button >= GHOSTTY_MOUSE_BUTTON_LEFT && button <= GHOSTTY_MOUSE_BUTTON_MIDDLE)
    state->mouse_pressed = true;
  else if (action == GHOSTTY_MOUSE_ACTION_RELEASE)
    state->mouse_pressed = false;
  return result;
}

int eg_terminal_encode_focus(EgTerminal* state,
                             bool focused,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len) {
  if (state == NULL || out_len == NULL) return GHOSTTY_INVALID_VALUE;
  bool reporting = false;
  if (ghostty_terminal_mode_get(
          state->terminal, GHOSTTY_MODE_FOCUS_EVENT, &reporting) != GHOSTTY_SUCCESS ||
      !reporting) {
    *out_len = 0;
    return GHOSTTY_SUCCESS;
  }
  return ghostty_focus_encode(
      focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
      (char*)out, cap, out_len);
}
