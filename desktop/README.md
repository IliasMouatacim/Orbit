# Orbit Chat for Windows

Extract the Windows build artifact and launch `orbit-chat.exe`. The executable includes Orbit’s interface and opens its own window even when offline. Messaging, account access and calls require connectivity to the Orbit chat server. Windows 10 or 11 x64 needs Microsoft's Evergreen WebView2 Runtime.

## Build

Install Node.js 24, Rust stable for x86_64-pc-windows-msvc, and Visual Studio Build Tools with the Desktop development with C++ workload. From the repository root run:

    npm ci --prefix frontend
    npm run build --prefix desktop
    cargo build --locked --release --manifest-path desktop/src-tauri/Cargo.toml

The portable executable is `desktop/src-tauri/target/release/orbit-chat.exe`. The Build Orbit for Windows workflow tests that the application opens a window on Windows, packages the executable and generates its SHA-256 checksum. Pushing a version tag publishes the ZIP and checksum to GitHub Releases. Manual workflow runs produce build artifacts only.

The build uses the frontend's default HTTPS API, or the HTTPS origin set in VITE_API_URL at build time. Include `https://tauri.localhost` alongside existing web origins in the deployed backend's comma-separated CLIENT_ORIGIN setting. The Render blueprint includes it.
