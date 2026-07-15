use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let default_prefix = manifest.join("../../../build/ghostty/install");
    let prefix = env::var_os("GHOSTTY_VT_PREFIX")
        .map(PathBuf::from)
        .unwrap_or(default_prefix);
    let include = prefix.join("include");
    let library = prefix.join("lib/libghostty-vt.a");
    if !library.exists() {
        panic!(
            "libghostty-vt was not built at {}. Run `npm run build:ghostty-vt` from the repository root.",
            library.display(),
        );
    }

    // Give the static archive a unique link name. macOS's linker can otherwise
    // prefer the sibling libghostty-vt.dylib even when Cargo requests a static
    // library, which leaves the sidecar with an unexpected @rpath dependency.
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let static_library = out.join("libelectron_ghostty_vt_static.a");
    fs::copy(&library, &static_library).expect("copy libghostty-vt static archive");

    cc::Build::new()
        .file("src/ghostty_shim.c")
        .include(include)
        .define("GHOSTTY_STATIC", None)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("electron_ghostty_shim");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=electron_ghostty_vt_static");
    println!("cargo:rerun-if-changed={}", library.display());
    println!("cargo:rerun-if-changed=src/ghostty_shim.c");
    println!("cargo:rerun-if-changed=src/ghostty_shim.h");
    println!("cargo:rerun-if-env-changed=GHOSTTY_VT_PREFIX");
}
