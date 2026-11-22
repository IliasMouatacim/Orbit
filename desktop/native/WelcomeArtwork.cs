using System.Drawing.Drawing2D;

namespace Orbit;

internal sealed class WelcomeArtwork : Panel
{
    readonly Bitmap scene;
    public WelcomeArtwork()
    {
        using var stream = typeof(WelcomeArtwork).Assembly.GetManifestResourceStream("Orbit.WelcomeArt")!;
        using var original = Image.FromStream(stream);
        scene = new Bitmap(original);
        DoubleBuffered = true;
        ResizeRedraw = true;
        AccessibleName = "Orbit private chat and calls";
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Width <= 0 || Height <= 0) return;
        var g = e.Graphics;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        float scale = Math.Max((float)Width / scene.Width, (float)Height / scene.Height);
        float w = scene.Width * scale, h = scene.Height * scale;
        g.DrawImage(scene, (Width-w)/2, (Height-h)/2, w, h);
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
        if(disposing) scene.Dispose();
        base.Dispose(disposing);
    }
}
