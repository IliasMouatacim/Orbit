# Orbit Chat for Windows

On Windows 10 or 11 x64, extract the ZIP and open orbit-chat.exe. Install Microsoft's Evergreen WebView2 Runtime if startup reports that it is missing. Internet access is required. Camera and microphone access use WebView2 and Windows privacy settings.

The desktop client loads the hosted Orbit Chat interface. The TypeScript startup page handles offline launch. The Rust shell restricts top-level navigation to the app and chat origins, blocks popups, and exposes no custom native commands. The standalone executable is unsigned.

## Build on Windows

Install Node.js, Rust stable for x86_64-pc-windows-msvc, and Visual Studio Build Tools with the Desktop development with C++ workload. From the project folder run:

    npm install
    npm run build
    cargo build --locked --release --manifest-path src-tauri/Cargo.toml

The executable is src-tauri/target/release/orbit-chat.exe.
