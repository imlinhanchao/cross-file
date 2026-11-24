// Desktop-only shim. On Android/iOS the library below is the app entry point
// (`#[tauri::mobile_entry_point]`); on a desktop host `cargo check`/`cargo run`
// still work through this `main`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    crossfile_mobile_lib::run()
}
