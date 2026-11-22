using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace Orbit;

internal sealed class WelcomeArtwork : Panel
{
    readonly Bitmap scene;
    readonly System.Windows.Forms.Timer frames = new() { Interval = 32 };
    readonly Stopwatch elapsed = new();
    Bitmap? backdrop;
    Size cachedSize;
    Form? host;

    public WelcomeArtwork()
    {
        using var stream = typeof(WelcomeArtwork).Assembly.GetManifestResourceStream("Orbit.WelcomeArt")!;
        using var original = Image.FromStream(stream);
        scene = new Bitmap(original);
        DoubleBuffered = true;
        ResizeRedraw = true;
        frames.Tick += (_, _) => Invalidate();
        AccessibleName = "Orbit private chat and calls";
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        host = FindForm();
        if (host != null) {
            host.Activated += RefreshMotion;
            host.Deactivate += PauseMotion;
            host.Resize += RefreshMotion;
            Microsoft.Win32.SystemEvents.UserPreferenceChanged += PreferenceChanged;
        }
        RefreshMotion(this, EventArgs.Empty);
    }

    void PreferenceChanged(object sender, Microsoft.Win32.UserPreferenceChangedEventArgs e)
    {
        if (IsHandleCreated && !Disposing) BeginInvoke(() => RefreshMotion(this, EventArgs.Empty));
    }

    void RefreshMotion(object? sender, EventArgs e)
    {
        if (WelcomeMotion.Enabled && Visible && host != null && Form.ActiveForm == host && host.WindowState != FormWindowState.Minimized) {
            elapsed.Start();
            frames.Start();
        } else {
            PauseMotion(sender, e);
            if (!WelcomeMotion.Enabled) elapsed.Reset();
        }
        Invalidate();
    }

    void PauseMotion(object? sender, EventArgs e) { frames.Stop(); elapsed.Stop(); }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        PauseMotion(this, e);
        if (host != null) {
            host.Activated -= RefreshMotion;
            host.Deactivate -= PauseMotion;
            host.Resize -= RefreshMotion;
            Microsoft.Win32.SystemEvents.UserPreferenceChanged -= PreferenceChanged;
            host = null;
        }
        base.OnHandleDestroyed(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width <= 0 || Height <= 0) return;
        var g = e.Graphics;
        // Scale once on resize, then pan the cached scene without resampling each frame.
        int bleed = Math.Max(8, Width / 40);
        if (cachedSize != ClientSize || backdrop == null) {
            backdrop?.Dispose();
            cachedSize = ClientSize;
            backdrop = new Bitmap(Width + bleed * 2, Height + bleed * 2);
            using var cache = Graphics.FromImage(backdrop);
            cache.InterpolationMode = InterpolationMode.HighQualityBicubic;
            float scale = Math.Max((float)backdrop.Width / scene.Width, (float)backdrop.Height / scene.Height);
            float w = scene.Width * scale, h = scene.Height * scale;
            cache.DrawImage(scene, (backdrop.Width-w)/2, (backdrop.Height-h)/2, w, h);
        }
        double t = elapsed.Elapsed.TotalSeconds;
        float x = (float)(bleed * .85 * Math.Sin(t * .24));
        float y = (float)(bleed * .65 * Math.Sin(t * .17));
        g.DrawImageUnscaled(backdrop, -bleed + (int)Math.Round(x), -bleed + (int)Math.Round(y));
        g.SmoothingMode = SmoothingMode.AntiAlias;
        for (int i = 0; i < 14; i++) {
            float sx = (i * 0.618034f % 1) * Width + x * .4f;
            float sy = ((i + 1) * 0.381966f % 1) * Height + y * .4f;
            if (sy > Height * .25 && sy < Height * .68 && sx > Width * .16 && sx < Width * .8) continue;
            using var star = new SolidBrush(Color.FromArgb((int)(120 + 70 * Math.Sin(t * .9 + i)), 248, 236, 209));
            g.FillEllipse(star, sx, sy, 2.3f, 2.3f);
        }
        int inset = Math.Max(20, Width/13);
        using var brand = new Font("Segoe UI", Math.Clamp(Width/24f,16,25), FontStyle.Bold,GraphicsUnit.Pixel);
        using var heading = new Font("Georgia", Math.Clamp(Width/9.8f,30,64),FontStyle.Regular,GraphicsUnit.Pixel);
        using var sub = new Font("Segoe UI",Math.Clamp(Width/32f,13,19),GraphicsUnit.Pixel);
        var pale = Color.FromArgb(248,244,231);
        TextRenderer.DrawText(g,"orbit.",brand,new Point(inset,inset),pale);
        int baseline = Height - inset - sub.Height*2;
        TextRenderer.DrawText(g,"Your space.",heading,new Point(inset,baseline-heading.Height),pale);
        TextRenderer.DrawText(g,"Private rooms, messages and calls.",sub,new Point(inset,baseline+6),pale);
    }
    protected override void Dispose(bool disposing)
    {
        if(disposing) { frames.Stop(); backdrop?.Dispose(); scene.Dispose(); }
        base.Dispose(disposing);
        if (disposing) frames.Dispose();
    }
}
