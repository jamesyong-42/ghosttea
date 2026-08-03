#ifndef GHOSTTEA_FONT_FIXTURE_H
#define GHOSTTEA_FONT_FIXTURE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  GHOSTTEA_FONT_FIXTURE_OK = 0,
  GHOSTTEA_FONT_FIXTURE_INVALID_ARGUMENT = 1,
  GHOSTTEA_FONT_FIXTURE_FAILED = 2,
  GHOSTTEA_FONT_FIXTURE_PANIC = 3,
};

typedef struct ghosttea_font_bytes {
  const uint8_t *data;
  size_t len;
} ghosttea_font_bytes_t;

typedef struct ghosttea_owned_bytes {
  uint8_t *data;
  size_t len;
  size_t capacity;
} ghosttea_owned_bytes_t;

int32_t ghosttea_font_fixture_generate(
    ghosttea_font_bytes_t regular,
    ghosttea_font_bytes_t bold,
    ghosttea_font_bytes_t italic,
    ghosttea_font_bytes_t bold_italic,
    ghosttea_font_bytes_t emoji,
    ghosttea_font_bytes_t symbols_math,
    ghosttea_font_bytes_t symbols,
    ghosttea_font_bytes_t emoji_text,
    ghosttea_owned_bytes_t *out);

void ghosttea_font_fixture_free(ghosttea_owned_bytes_t bytes);

#ifdef __cplusplus
}
#endif

#endif
