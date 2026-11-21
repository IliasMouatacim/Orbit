# Orbit Chat for Windows

The native client uses Windows Forms for its interface, Windows audio and camera APIs for capture and playback, and a .NET WebRTC stack for voice and video. The checkout builds a self-contained x64 application for Windows 10 (1809+) and Windows 11. The previously published 1.0.1 download uses the earlier WebView2 client.

## Build and test

Install the .NET 10 SDK. From the repository root:

    dotnet restore desktop/native/Orbit.csproj -r win-x64 --locked-mode
    dotnet publish desktop/native/Orbit.csproj -c Release -r win-x64 --self-contained true --no-restore -o windows-build

Keep the published files together. Start `windows-build/OrbitChat.exe`. Use the Windows microphone and camera privacy settings to enable access for desktop apps. For calls across restrictive networks, configure a TURN service via ORBIT_TURN_URL, ORBIT_TURN_USERNAME and ORBIT_TURN_CREDENTIAL in the running client's environment. The app uses the hosted Orbit relay and asks users to exchange verification codes over an independent trusted channel before direct messaging or calling.

With the local backend running on port 4000, run:

    dotnet run --project desktop/native-check

The integration check creates two independent native client sessions. It checks encrypted global, room and direct messages, voice and video negotiation, bidirectional decoding of generated audio and video, and remote hangup. The Windows workflow also checks that the application opens a window. Use two Windows machines with microphones, speakers and cameras to verify capture, playback, visible remote video and hangup before replacing the public download.

The signaling and text protocol is shared with the web client. Each native sign-in uses a new device key and stores account tokens only in memory. The native client returns to the join screen on disconnection.
