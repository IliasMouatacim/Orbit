using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Orbit;

// Engine.IO v4 over WebSocket, default Socket.IO namespace, JSON events and acknowledgements.
internal sealed class Relay : IDisposable
{
    readonly ClientWebSocket socket = new();
    readonly SemaphoreSlim writer = new(1);
    readonly CancellationTokenSource lifetime = new();
    readonly Dictionary<int, TaskCompletionSource<bool>> pending = [];
    int nextId;
    public string Id { get; private set; } = "";
    public event Action<string, JsonElement>? Received;
    public event Action? Disconnected;

    public async Task Connect(Uri origin, string publicKey, string? token)
    {
        var url = new UriBuilder(origin)
        {
            Scheme = origin.Scheme == "https" ? "wss" : "ws",
            Path = "/socket.io/",
            Query = "EIO=4&transport=websocket"
        }.Uri;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(TimeSpan.FromSeconds(45));
        await socket.ConnectAsync(url, timeout.Token);
        if (!(await Read(timeout.Token)).StartsWith('0')) throw new IOException("Invalid chat handshake.");
        await Write("40" + JsonSerializer.Serialize(new { publicKey, token }));
        string frame;
        while ((frame = await Read(timeout.Token)) == "2") await Write("3");
        if (!frame.StartsWith("40")) throw new IOException("Chat sign-in was refused.");
        Id = JsonSerializer.Deserialize<JsonElement>(frame[2..]).GetProperty("sid").GetString()!;
        _ = Listen();
    }

    async Task<string> Read(CancellationToken ct)
    {
        var chunk = new byte[8192];
        using var data = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(new ArraySegment<byte>(chunk), ct);
            if (result.MessageType != WebSocketMessageType.Text || data.Length + result.Count > 1_000_000)
                throw new IOException("Chat connection closed.");
            data.Write(chunk, 0, result.Count);
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(data.GetBuffer(), 0, (int)data.Length);
    }

    async Task Write(string frame)
    {
        await writer.WaitAsync(lifetime.Token);
        try { await socket.SendAsync(Encoding.UTF8.GetBytes(frame), WebSocketMessageType.Text, true, lifetime.Token); }
        finally { writer.Release(); }
    }

    public Task Emit(string name, object payload) => Write("42" + JsonSerializer.Serialize(new object[] { name, payload }));
    public async Task<bool> Deliver(object payload)
    {
        int id = ++nextId;
        var result = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending.Add(id, result);
        try
        {
            await Write("42" + id + JsonSerializer.Serialize(new object[] { "encrypted_text", payload }));
            return await result.Task.WaitAsync(TimeSpan.FromSeconds(8));
        }
        finally { pending.Remove(id); }
    }

    async Task Listen()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var frame = await Read(lifetime.Token);
                if (frame == "2") { await Write("3"); continue; }
                if (frame.StartsWith("41") || frame == "1") break;
                if (frame.StartsWith("42["))
                {
                    var args = JsonSerializer.Deserialize<JsonElement>(frame[2..]);
                    if (args.GetArrayLength() >= 1)
                        Received?.Invoke(args[0].GetString()!, args.GetArrayLength() > 1 ? args[1] : default);
                }
                else if (frame.StartsWith("43"))
                {
                    int start = frame.IndexOf('[');
                    if (start > 2 && int.TryParse(frame.AsSpan(2, start - 2), out int id) && pending.TryGetValue(id, out var result))
                        result.TrySetResult(frame[start..] == "[true]");
                }
            }
        }
        catch (Exception ex) when (ex is IOException or WebSocketException or OperationCanceledException or ObjectDisposedException or JsonException)
        {
            // All connection exits share cleanup below.
        }
        finally
        {
            foreach (var result in pending.Values) result.TrySetResult(false);
            if (!lifetime.IsCancellationRequested) Disconnected?.Invoke();
        }
    }
    public void Dispose() { lifetime.Cancel(); socket.Dispose(); }
}
