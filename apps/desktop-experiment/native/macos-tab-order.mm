#include <node_api.h>

#include <cstring>
#include <vector>

#import <Cocoa/Cocoa.h>

namespace {

bool Check(napi_env env, napi_status status, const char* message) {
  if (status == napi_ok) return true;
  napi_throw_error(env, nullptr, message);
  return false;
}

NSWindow* WindowFromHandle(napi_env env, napi_value handle) {
  void* bytes = nullptr;
  size_t length = 0;
  if (!Check(env, napi_get_buffer_info(env, handle, &bytes, &length),
             "native window handle must be a Buffer")) {
    return nil;
  }
  if (length < sizeof(void*)) {
    napi_throw_range_error(env, nullptr, "native window handle is truncated");
    return nil;
  }
  void* pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  return view.window;
}

napi_value TabOrder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (!Check(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
             "could not read tab order arguments")) {
    return nullptr;
  }
  bool is_array = false;
  if (argc != 1 || !Check(env, napi_is_array(env, argv[0], &is_array),
                          "could not inspect tab handles") ||
      !is_array) {
    napi_throw_type_error(env, nullptr, "tabOrder expects an array of native window handles");
    return nullptr;
  }

  uint32_t count = 0;
  if (!Check(env, napi_get_array_length(env, argv[0], &count),
             "could not read tab handle count")) {
    return nullptr;
  }
  std::vector<NSWindow*> candidates;
  candidates.reserve(count);
  for (uint32_t index = 0; index < count; ++index) {
    napi_value handle;
    if (!Check(env, napi_get_element(env, argv[0], index, &handle),
               "could not read native window handle")) {
      return nullptr;
    }
    NSWindow* window = WindowFromHandle(env, handle);
    if (window == nil) return nullptr;
    candidates.push_back(window);
  }

  NSArray<NSWindow*>* native_order = count == 0 ? @[] : candidates[0].tabbedWindows;
  if (native_order == nil || native_order.count == 0) {
    native_order = count == 0 ? @[] : @[ candidates[0] ];
  }

  napi_value result;
  if (!Check(env, napi_create_array_with_length(env, native_order.count, &result),
             "could not create tab order result")) {
    return nullptr;
  }
  uint32_t output_index = 0;
  for (NSWindow* window in native_order) {
    for (uint32_t candidate_index = 0; candidate_index < candidates.size(); ++candidate_index) {
      if (candidates[candidate_index] != window) continue;
      napi_value value;
      if (!Check(env, napi_create_uint32(env, candidate_index, &value),
                 "could not encode tab order index") ||
          !Check(env, napi_set_element(env, result, output_index++, value),
                 "could not append tab order index")) {
        return nullptr;
      }
      break;
    }
  }
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (!Check(env, napi_create_function(env, "tabOrder", NAPI_AUTO_LENGTH, TabOrder, nullptr,
                                       &function),
             "could not create tabOrder function") ||
      !Check(env, napi_set_named_property(env, exports, "tabOrder", function),
             "could not export tabOrder function")) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
