using System.Security.Cryptography;
using System.Text.Json;
using SIPSorcery.Net;

namespace Orbit;

internal interface ICallMedia
{
    Task Attach(RTCPeerConnection connection);
    Task Start();
    Task Stop();
}

// A verified device pair owns one call. Camera and microphone are acquired only on Dial or Accept.
internal sealed class Calls
{
    readonly Chat chat;
    readonly Func<bool, ICallMedia> mediaFactory;
    readonly SynchronizationContext ui;
    readonly HashSet<string> offers = [];
    sealed class Session(string id, Peer peer, bool video)
    {
        public readonly string Id = id;
        public readonly Peer Peer = peer;
        public readonly bool Video = video;
        public readonly Queue<string> LocalIce = [], RemoteIce = [];
        public RTCSessionDescriptionInit? Offer;
        public ICallMedia? Media;
        public RTCPeerConnection? PC;
        public bool SentDescription, RemoteReady;
    }
    Session? current;
    bool stopping;
    public bool Busy => current != null || stopping;
    public bool VideoActive => current?.Video == true;
    public bool Ringing => current?.Offer != null && current.PC == null;
    public event Action<string>? Status;
    public Calls(Chat chat, Func<bool, ICallMedia> factory)
    {
        this.chat = chat; mediaFactory = factory;
        ui = SynchronizationContext.Current ?? throw new InvalidOperationException("Call handling requires a dispatcher.");
        chat.Signal += Receive;
        chat.Changed += () =>
        {
            if (current is { } s && (!chat.People.TryGetValue(s.Peer.Id, out var p) || !ReferenceEquals(s.Peer, p))) _ = End();
        };
    }

    object Packet(Session s, string type, string json)
    {
        var (nonce, box) = Device.Seal(s.Peer.Key, ["call", s.Id, type, chat.Relay.Id, s.Peer.Id], json);
        return new { callId = s.Id, nonce, box };
    }
    string Read(Session s, string type, JsonElement packet)
    {
        if (Chat.Str(packet, "callId") != s.Id) throw new CryptographicException();
        return Device.Open(s.Peer.Key, ["call", s.Id, type, s.Peer.Id, chat.Relay.Id], packet, 65536);
    }
    public async Task Dial(Peer peer, bool video)
    {
        if (Busy || !peer.Verified) throw new InvalidOperationException("Select a verified contact.");
        var s = current = new Session(Guid.NewGuid().ToString(), peer, video);
        await Negotiate(s);
    }
    public async Task Accept()
    {
        if (Ringing) await Negotiate(current!);
    }
    async Task Negotiate(Session s)
    {
        try
        {
            var ice = new List<RTCIceServer> { new() { urls = "stun:stun.l.google.com:19302" } };
            if (Environment.GetEnvironmentVariable("ORBIT_TURN_URL") is { Length: > 0 } url)
                ice.Add(new()
                {
                    urls = url,
                    username = Environment.GetEnvironmentVariable("ORBIT_TURN_USERNAME"),
                    credential = Environment.GetEnvironmentVariable("ORBIT_TURN_CREDENTIAL")
                });
            var pc = s.PC = new RTCPeerConnection(new RTCConfiguration { iceServers = ice });
            var media = s.Media = mediaFactory(s.Video);
            Status?.Invoke("Opening media devices…");
            pc.onicecandidate += candidate => ui.Post(async _ =>
            {
                if (current != s) return;
                try
                {
                    if (!s.SentDescription) s.LocalIce.Enqueue(candidate.toJSON());
                    else await SendIce(s, candidate.toJSON());
                }
                catch { await Fail(s, "Could not exchange network candidates."); }
            }, null);
            pc.onconnectionstatechange += state => ui.Post(async _ =>
            {
                if (current != s) return;
                if (state == RTCPeerConnectionState.connected)
                {
                    try { await media.Start(); if (current == s) Status?.Invoke("In call with " + s.Peer.Name); }
                    catch { await Fail(s, "Could not start the microphone, speakers or camera."); }
                }
                else if (state == RTCPeerConnectionState.failed) await Fail(s, "Call connection failed.");
            }, null);
            await media.Attach(pc);
            if (current != s) { await media.Stop(); return; }
            bool answer = s.Offer != null;
            if (answer) SetRemote(s, s.Offer!);
            var local = answer ? pc.createAnswer() : pc.createOffer();
            await pc.setLocalDescription(local);
            if (current != s) return;
            var type = answer ? "answer" : "offer";
            var packet = Packet(s, type, JsonSerializer.Serialize(new { type, sdp = local.sdp }));
            if (answer) await chat.Relay.Emit("answer_call", new { to = s.Peer.Id, signal = packet });
            else await chat.Relay.Emit("call_user", new { userToCall = s.Peer.Id, signalData = packet });
            s.SentDescription = true;
            while (current == s && s.LocalIce.TryDequeue(out var iceJson)) await SendIce(s, iceJson);
            if (current == s && pc.connectionState != RTCPeerConnectionState.connected)
                Status?.Invoke(answer ? "Connecting call…" : "Calling " + s.Peer.Name + "…");
        }
        catch
        {
            await Fail(s, "Call setup failed. Check the connection, Windows media permissions and available devices.");
        }
    }
    Task SendIce(Session s, string json) => chat.Relay.Emit("ice_candidate", new { to = s.Peer.Id, candidate = Packet(s, "ice", json) });
    static void SetRemote(Session s, RTCSessionDescriptionInit description)
    {
        if (s.PC!.setRemoteDescription(description) != SetDescriptionResultEnum.OK) throw new InvalidOperationException();
        s.RemoteReady = true;
        while (s.RemoteIce.TryDequeue(out var json)) AddIce(s, json);
    }
    static void AddIce(Session s, string json)
    {
        if (RTCIceCandidateInit.TryParse(json, out var ice)) s.PC!.addIceCandidate(ice);
    }
    void Receive(string kind, JsonElement msg)
    {
        try
        {
            if (kind == "end_call") { _ = End(false); return; }
            if (kind == "call_user")
            {
                if (Busy || !chat.People.TryGetValue(Chat.Str(msg, "from"), out var peer) || !peer.Verified) return;
                var packet = msg.GetProperty("signal");
                var id = Chat.Str(packet, "callId");
                if (!Guid.TryParseExact(id, "D", out _) || offers.Contains(id)) return;
                var s = new Session(id, peer, false);
                var desc = JsonSerializer.Deserialize<JsonElement>(Read(s, "offer", packet));
                if (Chat.Str(desc, "type") != "offer") return;
                var sdp = Chat.Str(desc, "sdp");
                current = new(id, peer, sdp.Split('\n').Any(line => line.StartsWith("m=video ")))
                {
                    Offer = new() { type = RTCSdpType.offer, sdp = sdp }
                };
                offers.Add(id);
                Status?.Invoke($"{peer.Name} is calling ({(current.Video ? "video" : "voice")}).");
            }
            else if (current is { } s && kind == "call_accepted" && s.PC != null && s.Offer == null && !s.RemoteReady)
            {
                var desc = JsonSerializer.Deserialize<JsonElement>(Read(s, "answer", msg));
                if (Chat.Str(desc, "type") == "answer") SetRemote(s, new() { type = RTCSdpType.answer, sdp = Chat.Str(desc, "sdp") });
            }
            else if (current is { } c && kind == "ice_candidate" && Chat.Str(msg, "from") == c.Peer.Id)
            {
                string json = Read(c, "ice", msg.GetProperty("candidate"));
                if (c.RemoteReady) AddIce(c, json);
                else if (c.RemoteIce.Count < 128) c.RemoteIce.Enqueue(json);
            }
        }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException or InvalidOperationException or KeyNotFoundException)
        {
            // Invalid or stale negotiation data is discarded.
        }
    }
    async Task Fail(Session s, string reason) { if (current == s) { await End(); Status?.Invoke(reason); } }
    public async Task End(bool notify = true)
    {
        if (current is not { } s) return;
        current = null; stopping = true;
        try
        {
            if (notify) await chat.Relay.Emit("end_call", new { to = s.Peer.Id });
        }
        catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException or System.Net.WebSockets.WebSocketException) { }
        finally
        {
            try
            {
                s.PC?.Close("Call ended");
                if (s.Media != null) await s.Media.Stop();
            }
            finally
            {
                s.PC?.Dispose();
                stopping = false;
                Status?.Invoke("Call ended.");
            }
        }
    }
}
