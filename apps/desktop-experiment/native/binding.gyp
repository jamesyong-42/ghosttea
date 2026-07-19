{
  "targets": [
    {
      "target_name": "ghosttea_native_tabs",
      "sources": ["macos-tab-order.mm"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "MACOSX_DEPLOYMENT_TARGET": "12.0",
              "OTHER_LDFLAGS": ["-framework Cocoa"]
            }
          }
        ],
        ["OS!='mac'", { "type": "none" }]
      ]
    }
  ]
}
