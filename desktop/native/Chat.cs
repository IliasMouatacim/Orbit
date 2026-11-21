using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Orbit;

internal record Peer(string Id, string Name, string PublicKey, byte[] Key, string OwnCode, string TheirCode)
{
    public bool Verified { get; set; }
}
internal record Room(string Id, string Label, string Invite, byte[] Key);
internal sealed class Chat : IDisposable
{
    public readonly Relay Relay = new();
    readonly Device device = new();
    readonly Dictionary<string, string> pins = [];
    readonly HashSet<string> seen = [];
    public Dictionary<string, Peer> People { get; private set; } = [];
    public Dictionary<string, Room> Rooms { get; } = [];
    public string Name { get; private set; } = "";
    public event Action? Changed;
    public event Action<string, string, string>? Message;
    public event Action<string, JsonElement>? Signal;
    public Chat() => Relay.Received += Receive;

    public async Task Join(Uri origin, string name, string? token)
    {
        Name = name;
        await Relay.Connect(origin, device.PublicKey, token);
        await Relay.Emit("join_room", name);
    }

    void Receive(string kind, JsonElement packet)
    {
        try
        {
            switch (kind)
            {
                case "online_users":
                    var directory = new Dictionary<string, Peer>();
                    foreach (var user in packet.EnumerateArray())
                    {
                        if (!user.GetProperty("joined").GetBoolean()) continue;
                        var id = Str(user, "id"); var name = Str(user, "name"); var pk = Str(user, "publicKey");
                        if (pins.TryGetValue(id, out var pinned) && pinned != pk) continue;
                        if (People.TryGetValue(id, out var old) && old.Name == name && old.PublicKey == pk)
                        {
                            directory[id] = old;
                            continue;
                        }
                        try
                        {
                            var key = device.Shared(pk);
                            string[] me = [Relay.Id, Name, device.PublicKey], them = [id, name, pk];
                            directory[id] = new(id, name, pk, key, Device.Code(me, them), Device.Code(them, me));
                            pins[id] = pk;
                        }
                        catch (Exception e) when (e is CryptographicException or FormatException) { continue; }
                    }
                    People = directory;
                    Changed?.Invoke();
                    break;
                case "encrypted_text":
                    var from = Str(packet, "from"); var to = Str(packet, "to"); var channel = Str(packet, "kind");
                    if (!People.TryGetValue(from, out var sender)) return;
                    byte[] shared;
                    string chat;
                    if (channel == "room" && Rooms.TryGetValue(to, out var room) && Str(packet, "target") == to)
                    {
                        shared = room.Key; chat = to;
                    }
                    else if (to == Relay.Id && (channel == "global" || (channel == "direct" && sender.Verified)))
                    {
                        shared = sender.Key; chat = channel == "direct" ? from : "global";
                    }
                    else return;
                    string text = Device.Open(shared, [channel, from, to], packet, 500);
                    if (seen.Add(from + "/" + Str(packet, "nonce"))) Message?.Invoke(chat, sender.Name, text);
                    break;
                case "call_user":
                case "call_accepted":
                case "ice_candidate":
                case "end_call":
                    Signal?.Invoke(kind, packet);
                    break;
            }
        }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException or KeyNotFoundException or InvalidOperationException)
        {
            // Ignore malformed or unauthenticated relay data.
        }
    }
    public static string Str(JsonElement value, string key) => value.GetProperty(key).GetString() ?? throw new JsonException();
    public async Task<Room> JoinRoom(string entry)
    {
        var fields = entry.Trim().Split('~');
        var label = Regex.Replace(fields[0], "[^a-zA-Z0-9_-]", "");
        if (label.Length is 0 or > 32 || fields.Length > 2 || (fields.Length == 2 && !Regex.IsMatch(fields[1], "^[a-f0-9]{64}$")))
            throw new ArgumentException("Enter a room name or the complete private invitation.");
        var key = fields.Length == 2 ? Convert.FromHexString(fields[1]) : RandomNumberGenerator.GetBytes(32);
        var id = Convert.ToHexStringLower(SHA512.HashData(key).AsSpan(0, 16));
        if (Rooms.TryGetValue(id, out var existing)) return existing;
        if (Rooms.Count >= 128) throw new InvalidOperationException("Room limit reached.");
        await Relay.Emit("join_private_room", id);
        var room = new Room(id, label, label + "~" + Convert.ToHexStringLower(key), key);
        Rooms[id] = room;
        Changed?.Invoke();
        return room;
    }

    public async Task Send(string target, string text)
    {
        if (text.Length is 0 or > 500 || !People.ContainsKey(Relay.Id)) throw new InvalidOperationException("Wait for the connection and enter up to 500 characters.");
        string kind;
        var deliveries = new List<object>();
        void Add(string id, byte[] key, string channel)
        {
            var (nonce, box) = Device.Seal(key, [channel, Relay.Id, id], text);
            deliveries.Add(new { to = id, nonce, box });
        }
        if (target == "global")
        {
            kind = "global";
            foreach (var user in People.Values) Add(user.Id, user.Key, kind);
        }
        else if (Rooms.TryGetValue(target, out var room))
        {
            kind = "room"; Add(target, room.Key, kind);
        }
        else if (People.TryGetValue(target, out var peer) && peer.Verified)
        {
            kind = "direct"; Add(target, peer.Key, kind);
        }
        else throw new InvalidOperationException("Verify this device before sending.");
        if (!await Relay.Deliver(new { kind, target, deliveries })) throw new IOException("Delivery could not be confirmed.");
        if (kind == "direct") Message?.Invoke(target, Name, text);
    }
    public void Dispose() { Relay.Dispose(); device.Dispose(); }
}
