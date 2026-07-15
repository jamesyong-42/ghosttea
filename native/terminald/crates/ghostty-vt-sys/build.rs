use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_BUNDLE_SIZE: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    schema_version: u32,
    targets: BTreeMap<String, TargetArtifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetArtifact {
    filename: String,
    url: String,
    sha256: String,
    size: u64,
    library_sha256: String,
    headers_sha256: String,
}

fn main() {
    for variable in [
        "GHOSTTY_VT_PREFIX",
        "GHOSTTEA_GHOSTTY_VT_BUNDLE",
        "GHOSTTEA_GHOSTTY_VT_BASE_URL",
        "GHOSTTEA_GHOSTTY_VT_OFFLINE",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    println!("cargo:rerun-if-changed=artifacts.json");
    println!("cargo:rerun-if-changed=src/ghostty_shim.c");
    println!("cargo:rerun-if-changed=src/ghostty_shim.h");

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    let target = env::var("TARGET").expect("Cargo target triple");
    let manifest: ArtifactManifest = serde_json::from_str(include_str!("artifacts.json"))
        .expect("valid Ghostty artifact manifest");
    assert_eq!(
        manifest.schema_version, 1,
        "unsupported Ghostty artifact manifest"
    );
    let artifact = manifest.targets.get(&target).unwrap_or_else(|| {
        panic!(
            "Ghosttea has no Ghostty VT artifact for {target}; supported targets: {}",
            manifest
                .targets
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    });

    let prefix = resolve_prefix(&manifest_dir, &out, artifact);
    validate_install(&prefix, artifact);
    link(&prefix, &out);
}

fn resolve_prefix(manifest_dir: &Path, out: &Path, artifact: &TargetArtifact) -> PathBuf {
    if let Some(prefix) = env::var_os("GHOSTTY_VT_PREFIX") {
        return PathBuf::from(prefix);
    }

    if let Some(bundle) = env::var_os("GHOSTTEA_GHOSTTY_VT_BUNDLE") {
        return extract_bundle(&PathBuf::from(bundle), out, artifact);
    }

    let repository_prefix = manifest_dir.join("../../../build/ghostty/install");
    if repository_prefix.join("lib/libghostty-vt.a").is_file() {
        return repository_prefix;
    }

    if offline() {
        panic!(
            "Ghostty VT is unavailable in offline mode. Set GHOSTTY_VT_PREFIX or \
             GHOSTTEA_GHOSTTY_VT_BUNDLE to a verified local artifact."
        );
    }

    let url = env::var("GHOSTTEA_GHOSTTY_VT_BASE_URL")
        .map(|base| format!("{}/{}", base.trim_end_matches('/'), artifact.filename))
        .unwrap_or_else(|_| artifact.url.clone());
    let bundle = out.join(&artifact.filename);
    let mut response = ureq::get(&url)
        .call()
        .unwrap_or_else(|error| panic!("failed to download Ghostty VT from {url}: {error}"));
    let contents = response
        .body_mut()
        .with_config()
        .limit(MAX_BUNDLE_SIZE)
        .read_to_vec()
        .unwrap_or_else(|error| panic!("failed to read Ghostty VT bundle from {url}: {error}"));
    fs::write(&bundle, contents).expect("write downloaded Ghostty VT bundle");
    extract_bundle(&bundle, out, artifact)
}

fn extract_bundle(bundle: &Path, out: &Path, artifact: &TargetArtifact) -> PathBuf {
    println!("cargo:rerun-if-changed={}", bundle.display());
    let contents = fs::read(bundle).unwrap_or_else(|error| {
        panic!(
            "failed to read Ghostty VT bundle {}: {error}",
            bundle.display()
        )
    });
    assert_eq!(
        contents.len() as u64,
        artifact.size,
        "size mismatch for {}; refusing an incomplete native artifact",
        bundle.display()
    );
    verify_hash(bundle, &contents, &artifact.sha256);

    let prefix = out.join("ghostty-vt");
    if prefix.exists() {
        fs::remove_dir_all(&prefix).expect("remove stale Ghostty VT extraction");
    }
    fs::create_dir_all(&prefix).expect("create Ghostty VT extraction directory");
    let mut archive = tar::Archive::new(contents.as_slice());
    archive
        .unpack(&prefix)
        .unwrap_or_else(|error| panic!("failed to extract {}: {error}", bundle.display()));
    prefix
}

fn validate_install(prefix: &Path, artifact: &TargetArtifact) {
    let library = prefix.join("lib/libghostty-vt.a");
    let contents = fs::read(&library).unwrap_or_else(|error| {
        panic!(
            "failed to read required artifact {}: {error}",
            library.display()
        )
    });
    verify_hash(&library, &contents, &artifact.library_sha256);
    println!("cargo:rerun-if-changed={}", library.display());

    let include = prefix.join("include");
    let actual_headers = header_tree_hash(&include);
    assert_eq!(
        actual_headers,
        artifact.headers_sha256,
        "checksum mismatch for {}; refusing an untrusted native artifact",
        include.display()
    );
    println!("cargo:rerun-if-changed={}", include.display());
}

fn header_tree_hash(include: &Path) -> String {
    fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
        let entries = fs::read_dir(directory).unwrap_or_else(|error| {
            panic!(
                "failed to read header directory {}: {error}",
                directory.display()
            )
        });
        for entry in entries {
            let path = entry.expect("read header directory entry").path();
            if path.is_dir() {
                collect(&path, files);
            } else {
                files.push(path);
            }
        }
    }

    let mut files = Vec::new();
    collect(include, &mut files);
    files.sort_by_key(|path| {
        path.strip_prefix(include)
            .expect("header below include root")
            .to_string_lossy()
            .replace('\\', "/")
    });
    let mut inventory = Sha256::new();
    for path in files {
        let relative = path
            .strip_prefix(include)
            .expect("header below include root");
        let relative = relative.to_string_lossy().replace('\\', "/");
        let contents = fs::read(&path)
            .unwrap_or_else(|error| panic!("failed to read header {}: {error}", path.display()));
        let checksum = format!("{:x}", Sha256::digest(&contents));
        inventory.update(format!(
            "include/{relative}\0{checksum}\0{}\n",
            contents.len()
        ));
    }
    format!("{:x}", inventory.finalize())
}

fn verify_hash(path: &Path, contents: &[u8], expected: &str) {
    let actual = format!("{:x}", Sha256::digest(contents));
    assert_eq!(
        actual,
        expected,
        "checksum mismatch for {}; refusing an untrusted native artifact",
        path.display()
    );
}

fn link(prefix: &Path, out: &Path) {
    let library = prefix.join("lib/libghostty-vt.a");
    let include = prefix.join("include");

    // Give the static archive a unique link name. macOS's linker can otherwise
    // prefer a sibling dylib even when Cargo requests a static library.
    let static_library = out.join("libghosttea_ghostty_vt_static.a");
    fs::copy(&library, &static_library).expect("copy libghostty-vt static archive");

    cc::Build::new()
        .file("src/ghostty_shim.c")
        .include(include)
        .define("GHOSTTY_STATIC", None)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("ghosttea_ghostty_shim");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=ghosttea_ghostty_vt_static");
}

fn offline() -> bool {
    env::var("GHOSTTEA_GHOSTTY_VT_OFFLINE")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}
