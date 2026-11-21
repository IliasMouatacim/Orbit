#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Orbit Chat")
                .inner_size(1120.0, 780.0)
                .min_inner_size(420.0, 480.0)
                .on_navigation(|url| {
                    matches!(url.origin().ascii_serialization().as_str(),
                        "http://tauri.localhost" | "https://tauri.localhost" |
                        "https://chattingapp-kappa.vercel.app")
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Orbit Chat could not start");
}
