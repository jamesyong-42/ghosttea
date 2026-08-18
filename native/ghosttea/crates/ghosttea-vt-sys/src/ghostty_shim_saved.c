#include "ghostty_shim_internal.h"

#include <stdint.h>

static EgCharsetState eg_charset_state(GhosttyTerminalCharsetState source) {
  EgCharsetState result = {
      .g0 = (uint8_t)source.g0,
      .g1 = (uint8_t)source.g1,
      .g2 = (uint8_t)source.g2,
      .g3 = (uint8_t)source.g3,
      .gl = (uint8_t)source.gl,
      .gr = (uint8_t)source.gr,
      .single_shift = source.has_single_shift
          ? (uint8_t)source.single_shift
          : UINT8_MAX,
  };
  return result;
}

static GhosttyFormatterTerminalOptions eg_recovery_options(void) {
  GhosttyFormatterTerminalOptions options =
      GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_VT;
  options.unwrap = false;
  options.trim = false;
  options.extra = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalExtra);
  options.extra.palette = true;
  options.extra.modes = true;
  options.extra.scrolling_region = true;
  options.extra.tabstops = true;
  options.extra.pwd = true;
  options.extra.keyboard = true;
  options.extra.screen = GHOSTTY_INIT_SIZED(GhosttyFormatterScreenExtra);
  options.extra.screen.cursor = true;
  options.extra.screen.style = true;
  options.extra.screen.hyperlink = true;
  options.extra.screen.protection = true;
  options.extra.screen.kitty_keyboard = true;
  options.extra.screen.charsets = true;
  return options;
}

size_t eg_terminal_recovery_state(EgTerminal* state,
                                  uint8_t* out,
                                  size_t cap) {
  if (state == NULL || (out == NULL && cap != 0)) return SIZE_MAX;
  GhosttyFormatter formatter = NULL;
  GhosttyResult result = ghostty_formatter_terminal_state_new(
      NULL, &formatter, state->terminal, eg_recovery_options());
  if (result != GHOSTTY_SUCCESS) return SIZE_MAX;
  size_t written = 0;
  result = ghostty_formatter_format_buf(formatter, out, cap, &written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE)
    return SIZE_MAX;
  return written;
}

int eg_terminal_saved_cursor(EgTerminal* state,
                             uint8_t screen,
                             EgSavedCursor* out) {
  if (state == NULL || out == NULL || screen > 1) return -1;
  GhosttyTerminalSavedCursor cursor =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSavedCursor);
  GhosttyResult result = ghostty_terminal_saved_cursor(
      state->terminal, (GhosttyTerminalScreen)screen, &cursor);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return -1;
  out->x = cursor.x;
  out->y = cursor.y;
  eg_terminal_style(cursor.style, &out->style);
  out->protected_cell = cursor.protected_cell;
  out->pending_wrap = cursor.pending_wrap;
  out->origin = cursor.origin;
  out->charset = eg_charset_state(cursor.charset);
  return 1;
}
