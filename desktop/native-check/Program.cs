using System.Collections.Concurrent;
using System.Diagnostics;
using Orbit;
using SIPSorcery.Media;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using Vpx.Net;

sealed class EventLoop : SynchronizationContext
{
    readonly BlockingCollection<Action> work = [];
    public override void Post(SendOrPostCallback d, object? state) => work.Add(() => d(state));
    public void Run(Func<Task> test)
    {
        SetSynchronizationContext(this);
        var task = test();
        while (!task.IsCompleted) if (work.TryTake(out var action, 100)) action();
        task.GetAwaiter().GetResult();
    }
}

sealed class TestMedia(bool video) : ICallMedia
{
    readonly AudioEncoder encoder = new();
    readonly VP8Codec codec = new();
    AudioExtrasSource? tone;
    VideoTestPatternSource? pattern;
    public int AudioFrames, VideoFrames;

    public Task Attach(RTCPeerConnection pc)
    {
        tone = new(encoder, new AudioSourceOptions { AudioSource = AudioSourcesEnum.SineWave });
        tone.OnAudioSourceEncodedSample += pc.SendAudio;
        pc.OnAudioFormatsNegotiated += f => tone.SetAudioSourceFormat(f.First());
        pc.OnAudioFrameReceived += f =>
        {
            if (encoder.DecodeAudio(f.EncodedAudio, f.AudioFormat).Any(s => s != 0)) Interlocked.Increment(ref AudioFrames);
        };
        pc.addTrack(new MediaStreamTrack(tone.GetAudioSourceFormats(), MediaStreamStatusEnum.SendRecv));
        if (video)
        {
            pattern = new(codec);
            pattern.OnVideoSourceEncodedSample += pc.SendVideo;
            pc.OnVideoFormatsNegotiated += f => pattern.SetVideoSourceFormat(f.First());
            pc.OnVideoFrameReceived += (_, _, frame, fmt) =>
            {
                if (codec.DecodeVideo(frame, VideoPixelFormatsEnum.Bgr, fmt.Codec).Any(f => f.Width > 0 && f.Height > 0 && f.Sample.Length > 0))
                    Interlocked.Increment(ref VideoFrames);
            };
            pc.addTrack(new MediaStreamTrack(pattern.GetVideoSourceFormats(), MediaStreamStatusEnum.SendRecv));
        }
        return Task.CompletedTask;
    }
    public async Task Start() { await tone!.StartAudio(); if (pattern != null) await pattern.StartVideo(); }
    public async Task Stop() { if (tone != null) await tone.CloseAudio(); if (pattern != null) { await pattern.CloseVideo(); pattern.Dispose(); } }
}

static class Program
{
    static async Task Until(Func<bool> condition, string description)
    {
        var clock = Stopwatch.StartNew();
        while (!condition())
        {
            if (clock.Elapsed.TotalSeconds > 35) throw new TimeoutException(description);
            await Task.Delay(50);
        }
    }
    static void Main(string[] args) => new EventLoop().Run(async () =>
    {
        var server = new Uri(args.FirstOrDefault() ?? "http://127.0.0.1:4000");
        if (!server.IsLoopback) throw new ArgumentException("Run this integration check against a local test server.");
        using var a = new Chat(); using var b = new Chat();
        await a.Join(server, "First", null); await b.Join(server, "Second", null);
        await Until(() => a.People.ContainsKey(b.Relay.Id) && b.People.ContainsKey(a.Relay.Id), "Presence");
        var peerB = a.People[b.Relay.Id]; var peerA = b.People[a.Relay.Id];
        if (peerB.OwnCode != peerA.TheirCode || peerA.OwnCode != peerB.TheirCode) throw new Exception("Verification mismatch.");
        var inbox = new List<(string, string)>();
        b.Message += (id, _, text, _) => inbox.Add((id, text));
        await a.Send("global", "global check");
        var room = await a.JoinRoom("Native"); await b.JoinRoom(room.Invite);
        await a.Send(room.Id, "room check");
        try { await a.Send(peerB.Id, "unverified"); throw new Exception("Unverified send succeeded."); }
        catch (InvalidOperationException) { }
        peerA.Verified = peerB.Verified = true;
        await a.Send(peerB.Id, "direct check");
        await Until(() => inbox.Contains(("global", "global check")) && inbox.Contains((room.Id, "room check")) && inbox.Contains((peerA.Id, "direct check")), "Encrypted messages");
        Console.WriteLine("Global, private room and verified direct messages passed.");
        TestMedia? ma = null, mb = null;
        var ca = new Calls(a, v => ma = new(v)); var cb = new Calls(b, v => mb = new(v));
        ca.Status += s => Console.WriteLine("First: " + s); cb.Status += s => Console.WriteLine("Second: " + s);
        foreach (bool video in new[] { false, true })
        {
            await ca.Dial(peerB, video);
            await Until(() => cb.Ringing, "Incoming call");
            if (mb != null) throw new Exception("Remote capture opened before acceptance.");
            await cb.Accept();
            await Until(() => ma!.AudioFrames >= 3 && mb!.AudioFrames >= 3 && (!video || (ma.VideoFrames >= 2 && mb.VideoFrames >= 2)), "Bidirectional decoded media");
            Console.WriteLine($"Decoded audio frames {ma!.AudioFrames}/{mb!.AudioFrames}, video frames {ma.VideoFrames}/{mb.VideoFrames}.");
            await ca.End(); await Until(() => !cb.Busy, "Remote hangup"); ma = mb = null;
        }
    });
}
