using System.Drawing.Drawing2D;

namespace Orbit;

internal sealed class RoundedField : Panel
{
    readonly TextBox editor;

    public RoundedField(TextBox editor, int width)
    {
        this.editor = editor;
        DoubleBuffered = true;
        ResizeRedraw = true;
        TabStop = false;
        Size = new(width, 44);
        editor.BorderStyle = BorderStyle.None;
        editor.Dock = DockStyle.None;
        editor.BackColor = SystemColors.Window;
        editor.ForeColor = SystemColors.WindowText;
        Controls.Add(editor);
        editor.GotFocus += (_, _) => Invalidate();
        editor.LostFocus += (_, _) => Invalidate();
        MouseDown += (_, _) => editor.Focus();
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        if (editor == null) return;
        int inset = LogicalToDeviceUnits(16);
        editor.SetBounds(inset, (Height - editor.PreferredHeight) / 2,
            Math.Max(1, Width - inset * 2), editor.PreferredHeight);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        float stroke = LogicalToDeviceUnits(editor.Focused ? 2 : 1);
        var bounds = new RectangleF(stroke / 2, stroke / 2, Width - stroke, Height - stroke);
        if (bounds.Width < 1 || bounds.Height < 1) return;
        float radius = Math.Min(bounds.Height, bounds.Width) / 2;
        using var outline = new GraphicsPath();
        outline.AddRoundedRectangle(bounds, new SizeF(radius, radius));
        Color edge = SystemInformation.HighContrast
            ? (editor.Focused ? SystemColors.Highlight : SystemColors.WindowText)
            : (editor.Focused ? Color.FromArgb(41, 108, 80) : Color.FromArgb(153, 170, 158));
        using var pen = new Pen(edge, stroke);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.FillPath(SystemBrushes.Window, outline);
        e.Graphics.DrawPath(pen, outline);
    }
}
