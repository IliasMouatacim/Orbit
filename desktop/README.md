# Orbit Chat for Windows

The native client uses Windows Forms for its interface, Windows audio and camera APIs for capture and playback, and a .NET WebRTC stack for voice and video. The checkout builds a self-contained x64 application for Windows 10 (1809+) and Windows 11. The previously published 1.0.1 download uses the earlier WebView2 client.

## Build and test

Install the .NET 10 SDK. From the repository root:

    dotnet restore desktop/native/Orbit.csproj -r win-x64 --locked-mode
    dotnet publish desktop/native/Orbit.csproj -c Release -r win-x64 --self-contained true --no-restore -o windows-build

The Windows validation workflow includes the app-local Visual C++ runtime required by libsodium. For a manual build, install the Microsoft Visual C++ x64 redistributable or include its redistributable vcruntime140.dll. Keep the published files together. Start `windows-build/OrbitChat.exe`. Use the Windows microphone and camera privacy settings to enable access for desktop apps. For calls across restrictive networks, configure a TURN service via ORBIT_TURN_URL, ORBIT_TURN_USERNAME and ORBIT_TURN_CREDENTIAL in the running client's environment. The app uses the hosted Orbit relay and asks users to exchange verification codes over an independent trusted channel before direct messaging or calling.

With the local backend running on port 4000, run:

    dotnet run --project desktop/native-check

The integration check creates two independent native client sessions. It checks encrypted global, room and direct messages, voice and video negotiation, bidirectional decoding of generated audio and video, and remote hangup. The Windows workflow also checks that the application opens a window. Use two Windows machines with microphones, speakers and cameras to verify capture, playback, visible remote video and hangup before replacing the public download.

The signaling and text protocol is shared with the web client. Each native sign-in uses a new device key and stores account tokens only in memory. The native client returns to the join screen on disconnection.

## Windows publisher identity

Manual runs of **Native Windows checks** on `main` also produce `orbit-signed-windows-x64` after Windows verifies the timestamped Authenticode signature in the final ZIP. Use that artifact for distribution. The automatic branch and pull-request builds produce unsigned test packages.

To enable signing, create or reuse a Microsoft Artifact Signing **Public Trust** certificate profile with a validated publisher identity. Give the signing application the certificate profile signer role scoped to that profile. Configure a GitHub Actions federated credential in Microsoft Entra ID for subject `repo:IliasMouatacim/Orbit:environment:windows-signing` and audience `api://AzureADTokenExchange`. Restrict the GitHub environment `windows-signing` to deployments from `main`.

Set these variables in the GitHub environment: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `SIGNING_ENDPOINT` (the account's regional HTTPS endpoint), `SIGNING_ACCOUNT` and `SIGNING_PROFILE`. Authentication uses GitHub OIDC. SmartScreen evaluates download reputation separately from publisher identity.

## Free Microsoft Store distribution

Use Microsoft’s individual developer registration flow and choose free individual onboarding where offered. Complete identity verification and reserve the app name in Partner Center. From the product’s **Product identity** page, copy Package/Identity/Name, Package/Identity/Publisher and Package/Properties/PublisherDisplayName into the GitHub repository variables `STORE_IDENTITY_NAME`, `STORE_PUBLISHER` and `STORE_PUBLISHER_DISPLAY_NAME`, respectively.

Run **Native Windows checks** and download the **orbit-store-package** artifact. Without those variables it uses a development identity for packaging checks. With the assigned identity, upload the enclosed MSIX in Partner Center, complete the listing and privacy disclosures, explain that the full-trust capability runs the native Windows Forms chat and calling client, and submit for certification. Increase the manifest version for subsequent submissions, keeping its last component zero. After approval, distribute the Store listing URL. Microsoft signs the Store package. The ZIP linked as an unsigned test build uses a separate distribution path.
