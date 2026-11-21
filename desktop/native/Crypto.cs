using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Orbit;

internal sealed class Device : IDisposable
{
    [DllImport("libsodium")] static extern int sodium_init();
    [DllImport("libsodium")] static extern int crypto_box_keypair(byte[] pk, byte[] sk);
    [DllImport("libsodium")] static extern int crypto_box_beforenm(byte[] shared, byte[] pk, byte[] sk);
    [DllImport("libsodium")] static extern int crypto_secretbox_easy(byte[] cipher, byte[] plain, ulong length, byte[] nonce, byte[] key);
    [DllImport("libsodium")] static extern int crypto_secretbox_open_easy(byte[] plain, byte[] cipher, ulong length, byte[] nonce, byte[] key);

    readonly byte[] secret = new byte[32];
    public string PublicKey { get; }

    public Device()
    {
        var pk = new byte[32];
        if (sodium_init() < 0 || crypto_box_keypair(pk, secret) != 0) throw new CryptographicException();
        PublicKey = Convert.ToBase64String(pk);
    }

    public byte[] Shared(string publicKey)
    {
        var pk = Convert.FromBase64String(publicKey);
        var shared = new byte[32];
        if (pk.Length != 32 || crypto_box_beforenm(shared, pk, secret) != 0) throw new CryptographicException();
        return shared;
    }

    // Orbit's web client hashes JSON.stringify output, including literal Unicode.
    static string Identity(string[] fields) => "[" + string.Join(",", fields.Select(value =>
        "\"" + string.Concat(value.Select(c => c switch
        {
            '"' => "\\\"",
            '\\' => "\\\\",
            '\b' => "\\b",
            '\f' => "\\f",
            '\n' => "\\n",
            '\r' => "\\r",
            '\t' => "\\t",
            < ' ' => $"\\u{(int)c:x4}",
            _ => c.ToString()
        })) + "\"")) + "]";

    public static string Code(string[] from, string[] to)
    {
        string data = "[\"Orbit DM verification v2\"," + Identity(from) + "," + Identity(to) + "]";
        var hex = Convert.ToHexStringLower(SHA512.HashData(Encoding.UTF8.GetBytes(data)).AsSpan(0, 16));
        return string.Join(" ", Enumerable.Range(0, 8).Select(i => hex.Substring(i * 4, 4)));
    }

    public static (string nonce, string box) Seal(byte[] key, string[] context, string text)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes<string[]>(["Orbit text v1", .. context, text]);
        var nonce = RandomNumberGenerator.GetBytes(24);
        var cipher = new byte[plain.Length + 16];
        if (crypto_secretbox_easy(cipher, plain, (ulong)plain.Length, nonce, key) != 0) throw new CryptographicException();
        return (Convert.ToBase64String(nonce), Convert.ToBase64String(cipher));
    }

    public static string Open(byte[] key, string[] context, JsonElement packet, int maxLength)
    {
        var nonce = Convert.FromBase64String(packet.GetProperty("nonce").GetString()!);
        var cipher = Convert.FromBase64String(packet.GetProperty("box").GetString()!);
        if (nonce.Length != 24 || cipher.Length < 16 || cipher.Length > 100000) throw new CryptographicException();
        var plain = new byte[cipher.Length - 16];
        if (crypto_secretbox_open_easy(plain, cipher, (ulong)cipher.Length, nonce, key) != 0) throw new CryptographicException();
        var fields = JsonSerializer.Deserialize<string[]>(plain);
        if (fields == null || fields.Length != context.Length + 2 || fields[0] != "Orbit text v1" ||
            !fields.Skip(1).Take(context.Length).SequenceEqual(context) || fields[^1] is null ||
            fields[^1].Length > maxLength) throw new CryptographicException();
        return fields[^1];
    }
    public void Dispose() => CryptographicOperations.ZeroMemory(secret);
}
