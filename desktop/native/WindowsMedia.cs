using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using SIPSorcery.Media;
using SIPSorcery.Net;
using SIPSorceryMedia.Windows;
using Vpx.Net;

namespace Orbit;

internal sealed class WindowsMedia(bool withVideo, PictureBox display) : ICallMedia
{
    WindowsAudioEndPoint? audio;
    WindowsVideoEndPoint? video;
    VP8Codec? codec;
    volatile bool stopped;
    int framePending;
    Task? opening;
    public Task Attach(RTCPeerConnection pc) => opening = OpenDevices(pc);
    async Task OpenDevices(RTCPeerConnection pc)
    {
        if (NAudio.Wave.WaveIn.DeviceCount == 0 || NAudio.Wave.WaveOut.DeviceCount == 0)
            throw new InvalidOperationException("A microphone and speakers are required.");
        var a = audio = new WindowsAudioEndPoint(new AudioEncoder());
        a.OnAudioSourceEncodedSample += pc.SendAudio;
        pc.OnAudioFormatsNegotiated += formats =>
        {
            a.SetAudioSourceFormat(formats.First()); a.SetAudioSinkFormat(formats.First());
        };
        pc.OnAudioFrameReceived += a.GotEncodedMediaFrame;
        pc.addTrack(new MediaStreamTrack(a.GetAudioSourceFormats(), MediaStreamStatusEnum.SendRecv));
        if (!withVideo) return;
        codec = new VP8Codec();
        var v = video = new WindowsVideoEndPoint(codec);
        if (!await v.InitialiseVideoSourceDevice()) throw new InvalidOperationException("Camera unavailable.");
        if (stopped) return;
        v.OnVideoSourceEncodedSample += pc.SendVideo;
        v.OnVideoSinkDecodedSample += (bytes, w, h, stride, _) => Draw(bytes, (int)w, (int)h, stride);
        pc.OnVideoFrameReceived += v.GotVideoFrame;
        pc.OnVideoFormatsNegotiated += formats =>
        {
            v.SetVideoSourceFormat(formats.First()); v.SetVideoSinkFormat(formats.First());
        };
        pc.addTrack(new MediaStreamTrack(v.GetVideoSourceFormats(), MediaStreamStatusEnum.SendRecv));
    }
    void Draw(byte[] bytes, int width, int height, int stride)
    {
        if (stopped || width <= 0 || height <= 0 || width > 4096 || height > 4096 || stride < width * 3 ||
            (long)stride * height > bytes.Length || Interlocked.Exchange(ref framePending, 1) != 0) return;
        var image = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        var data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
        try
        {
            for (int row = 0; row < height; row++) Marshal.Copy(bytes, row * stride, data.Scan0 + row * data.Stride, width * 3);
        }
        finally { image.UnlockBits(data); }
        try
        {
            display.BeginInvoke(() =>
            {
                Interlocked.Exchange(ref framePending, 0);
                if (stopped || display.IsDisposed) { image.Dispose(); return; }
                var old = display.Image; display.Image = image; old?.Dispose();
            });
        }
        catch (InvalidOperationException) { image.Dispose(); Interlocked.Exchange(ref framePending, 0); }
    }
    public async Task Start()
    {
        if (stopped) return;
        if (audio != null) await audio.Start();
        if (!stopped && video != null) await video.StartVideo();
    }
    public async Task Stop()
    {
        if (stopped) return;
        stopped = true;
        if (opening != null) { try { await opening; } catch { /* Release partially opened devices below. */ } }
        if (audio != null) await audio.Close();
        if (video != null) await video.CloseVideo();
        else codec?.Dispose();
        var image = display.Image; display.Image = null; image?.Dispose();
    }
}
