fn main() {
    println!("cargo:rerun-if-env-changed=TRANSLOOP_UPDATE_PUBLIC_KEY_HEX");
    tauri_build::build()
}
