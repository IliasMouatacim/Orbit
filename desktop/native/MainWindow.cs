using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Orbit;

internal static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainWindow());
    }
}

internal sealed class MainWindow : Form
{
    static readonly Color Forest = Color.FromArgb(35, 62, 53);
    static readonly Color Paper = Color.FromArgb(247, 247, 242);
    static readonly Color Ink = Color.FromArgb(38, 61, 54);
    static readonly Color Clay = Color.FromArgb(164, 66, 35);
    static readonly Uri Server = new("https://chattingapp-n4ig.onrender.com");
    readonly HttpClient http = new() { BaseAddress = Server, Timeout = TimeSpan.FromSeconds(45) };
    readonly Label status = new() { Dock = DockStyle.Bottom, AutoSize = false, Height = 34, Padding = new(12, 7, 0, 0) };
    readonly Panel content = new() { Dock = DockStyle.Fill };
    readonly PictureBox video = new() { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.FromArgb(23, 35, 32) };
    readonly ListBox channels = new() { Dock = DockStyle.Fill, IntegralHeight = false, BorderStyle = BorderStyle.None };
    readonly TextBox search = new() { Dock = DockStyle.Top, PlaceholderText = "Find people or rooms" };
    readonly RichTextBox history = new() { Dock = DockStyle.Fill, ReadOnly = true, DetectUrls = false, BorderStyle = BorderStyle.None, BackColor = Color.White };
    readonly TextBox draft = new() { Dock = DockStyle.Fill, MaxLength = 500, PlaceholderText = "Write a message" };
    readonly RoundedField searchField, draftField;
    readonly Label title = new() { AutoSize = true, Font = new("Segoe UI", 16, FontStyle.Bold) };
    sealed record ChatLine(DateTime Received, string Author, string Body);
    readonly Dictionary<string, List<ChatLine>> logs = [];
    readonly Font authorFont = new("Segoe UI", 10, FontStyle.Bold);
    readonly Font timeFont = new("Segoe UI", 9);
    readonly Dictionary<string, string> drafts = [];
    Chat? chat;
    Calls? calls;
    string? token;
    string selected = "global";
    bool refreshing, sending, closing;
    Button? send, verify, voice, camera, accept, hang, invite;
    TableLayoutPanel? conversation;
    record Channel(string Id, string Label, string Badge) { public override string ToString() => Label; }

    public MainWindow()
    {
        Text = "Orbit Chat"; StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new(760, 520); Size = new(1050, 720); Font = new("Segoe UI", 10);
        BackColor = Paper;
        ForeColor = Ink;
        status.BackColor = Forest;
        status.ForeColor = Color.White;
        channels.BackColor = Forest;
        channels.ForeColor = Paper;
        channels.AccessibleName = "Conversations";
        channels.DrawMode = DrawMode.OwnerDrawFixed;
        channels.ItemHeight = channels.LogicalToDeviceUnits(44);
        channels.DpiChangedAfterParent += (_, _) => channels.ItemHeight = channels.LogicalToDeviceUnits(44);
        channels.DrawItem += DrawChannel;
        channels.Margin = new Padding(3, 10, 3, 12);
        Disposed += (_, _) => { authorFont.Dispose(); timeFont.Dispose(); };
        history.AccessibleName = "Conversation history";
        history.Margin = new Padding(8, 12, 8, 16);
        search.AccessibleName = "Find people or rooms";
        draft.AccessibleName = "Message";
        searchField = new RoundedField(search, 180) { Dock = DockStyle.Top };
        draftField = new RoundedField(draft, 280) { Dock = DockStyle.Top };
        Controls.Add(content); Controls.Add(status);
        channels.SelectedIndexChanged += (_, _) =>
        {
            if (!refreshing && channels.SelectedItem is Channel row) SelectChannel(row.Id);
        };
        search.TextChanged += (_, _) => Populate();
        draft.TextChanged += (_, _) => UpdateActions();
        draft.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; send?.PerformClick(); } };
        FormClosing += (_, e) =>
        {
            if (closing) return;
            e.Cancel = true; closing = true;
            BeginInvoke(async () => { try { await LeaveSpace(); } finally { Close(); } });
        };
        Shown += (_, _) => ShowLogin();
    }

    void DrawChannel(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= channels.Items.Count || channels.Items[e.Index] is not Channel row) return;
        bool active = e.State.HasFlag(DrawItemState.Selected);
        bool contrast = SystemInformation.HighContrast;
        Color background = contrast ? SystemColors.Window : Forest;
        Color selection = contrast ? SystemColors.Highlight : Color.FromArgb(62, 87, 73);
        Color text = contrast ? (active ? SystemColors.HighlightText : SystemColors.WindowText) : Paper;
        int gap = channels.LogicalToDeviceUnits(8);
        var bounds = Rectangle.Inflate(e.Bounds, -1, -2);
        if (bounds.Width < gap * 4 || bounds.Height < 4) return;
        using var surface = new SolidBrush(background);
        e.Graphics.FillRectangle(surface, e.Bounds);
        e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        if (active) {
            using var highlight = new SolidBrush(selection);
            e.Graphics.FillRoundedRectangle(highlight, bounds, new Size(gap, gap));
        }
        int diameter = bounds.Height - gap;
        var badge = new Rectangle(bounds.Left + gap, bounds.Top + gap / 2, diameter, diameter);
        using var badgeFill = new SolidBrush(contrast ? SystemColors.Window : Color.FromArgb(220, 229, 212));
        e.Graphics.FillEllipse(badgeFill, badge);
        var flags = TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix;
        TextRenderer.DrawText(e.Graphics, row.Badge, authorFont, badge, contrast ? SystemColors.WindowText : Forest,
            flags | TextFormatFlags.HorizontalCenter);
        var label = Rectangle.FromLTRB(badge.Right + gap, bounds.Top, bounds.Right - gap, bounds.Bottom);
        TextRenderer.DrawText(e.Graphics, row.Label, channels.Font, label, text, flags | TextFormatFlags.EndEllipsis);
        if (e.State.HasFlag(DrawItemState.Focus)) e.DrawFocusRectangle();
    }

    static void ShapeAsPill(Control control)
    {
        void UpdateShape()
        {
            int diameter = Math.Min(control.Width, control.Height);
            if (diameter < 1) return;
            using var path = new System.Drawing.Drawing2D.GraphicsPath();
            path.AddArc(0, 0, diameter, control.Height, 90, 180);
            path.AddArc(control.Width - diameter, 0, diameter, control.Height, 270, 180);
            path.CloseFigure();
            control.Region = new Region(path);
        }
        control.SizeChanged += (_, _) => UpdateShape();
        UpdateShape();
    }

    static Button ActionButton(string caption, Func<Task> action)
    {
        var b = new Button { Text = caption, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new(15, 4, 15, 4), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(233, 237, 228), ForeColor = Ink };
        b.FlatAppearance.BorderSize = 0;
        ShapeAsPill(b);
        b.Click += async (_, _) =>
        {
            try { await action(); }
            catch (Exception e) { if (!b.IsDisposed) MessageBox.Show(b.FindForm(), e.Message, "Orbit Chat", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        };
        return b;
    }
    static Label LabelFor(string text) => new() { Text = text, AutoSize = true, Margin = new(3, 10, 3, 4) };
    void ShowLogin()
    {
        content.Controls.Clear(); status.Text = "Orbit Chat for Windows";
        status.Visible = false;
        var stack = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.TopDown, WrapContents = false, Margin = Padding.Empty };
        var heading = new Label { Text = "Welcome to Orbit", Font = new("Segoe UI", 24, FontStyle.Bold), AutoSize = true };
        var intro = new Label { Text = "Choose how to join your workspace.", AutoSize = true, ForeColor = Color.FromArgb(84,97,90), Margin = new(4,4,0,24) };
        var choices = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, WrapContents = false, Margin = Padding.Empty };
        var tabStrip = new Panel { Size = new(282,40), Margin = new(3,0,0,14) };
        var indicator = new Panel { BackColor = Clay, Bounds = new Rectangle(0,37,91,3) };
        tabStrip.Controls.Add(choices);
        ShapeAsPill(indicator);
        tabStrip.Controls.Add(indicator);
        string[] captions = ["Guest","Sign in","Register"];
        var tabs = captions.Select(caption => new RadioButton { Text = caption, Appearance = Appearance.Button,
            TextAlign = ContentAlignment.MiddleCenter, FlatStyle = FlatStyle.Flat, AutoSize = false, Size = new(91,34), Margin = new(0,0,3,0) }).ToArray();
        foreach (var tab in tabs) { ShapeAsPill(tab); tab.FlatAppearance.BorderSize = 0; tab.FlatAppearance.CheckedBackColor = Forest; choices.Controls.Add(tab); }
        int mode = 0;
        var name = new TextBox { Width = 280, MaxLength = 254, Font = new("Segoe UI",12), PlaceholderText = "Your display name" };
        var password = new TextBox { Width = 280, UseSystemPasswordChar = true, MaxLength = 256, Font = name.Font };
        var email = new TextBox { Width = 280, MaxLength = 254, Font = name.Font };
        var who = LabelFor("Display name"); var pass = LabelFor("Password"); var address = LabelFor("Email (optional)");
        var nameField = new RoundedField(name, 280);
        password.AccessibleName = pass.Text;
        email.AccessibleName = address.Text;
        var passwordField = new RoundedField(password, 280);
        var emailField = new RoundedField(email, 280);
        stack.Controls.AddRange([heading,intro,tabStrip,who,nameField,pass,passwordField,address,emailField]);
        Button? join = null;
        join = ActionButton("Continue", async () =>
        {
            if (!stack.Enabled || string.IsNullOrWhiteSpace(name.Text)) return;
            stack.Enabled = false; status.Visible = true; status.Text = "Connecting…";
            Chat? next = null;
            try
            {
                next = new Chat();
                string handle = name.Text.Trim();
                if (mode == 0 && (handle.Length > 24 || handle.StartsWith('@'))) throw new ArgumentException("Choose a guest name of up to 24 characters without a leading @.");
                if (mode != 0)
                {
                    using var response = await http.PostAsJsonAsync(mode == 1 ? "/accounts/login" : "/accounts/register",
                        new { username = handle, password = password.Text, email = email.Text.Trim() });
                    var result = await response.Content.ReadFromJsonAsync<JsonElement>();
                    if (!response.IsSuccessStatusCode) throw new InvalidOperationException(Chat.Str(result, "error"));
                    token = Chat.Str(result, "token"); handle = Chat.Str(result, "name");
                }
                await next.Join(Server, handle, token);
                if (closing) { next.Dispose(); return; }
                chat = next;
                calls = new Calls(next, enabled => new WindowsMedia(enabled, video));
                next.Changed += Populate;
                next.Message += AddMessage;
                next.Relay.Disconnected += () => { if (chat == next) _ = Disconnected(); };
                calls.Status += message => { status.Text = message; UpdateActions(); };
                password.Clear(); ShowWorkspace();
            }
            catch { next?.Dispose(); token = null; status.Text = "Unable to join."; throw; }
            finally { if (!stack.IsDisposed) stack.Enabled = true; }
        });
        void UpdateForm()
        {
            passwordField.Visible = pass.Visible = mode != 0;
            emailField.Visible = address.Visible = mode == 2;
            who.Text = mode switch { 1 => "Username or email", 2 => "Username", _ => "Display name" };
            name.AccessibleName = who.Text;
            name.PlaceholderText = mode == 0 ? "Your display name" : who.Text;
            join.Text = mode switch { 1 => "Sign in", 2 => "Create account", _ => "Join as guest" };
            join.Enabled = !string.IsNullOrWhiteSpace(name.Text) && (mode == 0 || password.Text.Length > 0);
            join.BackColor = join.Enabled ? Clay : Color.FromArgb(226, 229, 222);
            foreach (var tab in tabs) {
                tab.BackColor = tab.Checked ? Forest : Color.FromArgb(227,233,225);
                tab.ForeColor = tab.Checked ? Color.White : Ink;
            }
        }
        name.TextChanged += (_,_) => UpdateForm();
        password.TextChanged += (_,_) => UpdateForm();
        join.AutoSize = false; join.Size = new(280,43); join.Margin = new(3,22,3,8);
        join.BackColor = Clay; join.ForeColor = Color.White;
        stack.Controls.Add(join);
        var welcome = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
        welcome.ColumnStyles.Add(new(SizeType.Percent, 52));
        welcome.ColumnStyles.Add(new(SizeType.Percent, 48));
        welcome.RowStyles.Add(new(SizeType.Percent,100));
        welcome.Controls.Add(new WelcomeArtwork { Dock = DockStyle.Fill, Margin = Padding.Empty },0,0);
        var formArea = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Paper, Margin = Padding.Empty };
        formArea.Controls.Add(stack);
        var transition = new System.Windows.Forms.Timer { Interval = 15 };
        var clock = new System.Diagnostics.Stopwatch();
        bool switching = false;
        int startY = 0, startX = 0;
        Point Center() => new(Math.Max(12,(formArea.ClientSize.Width-stack.Width)/2),
            Math.Max(12,(formArea.ClientSize.Height-stack.Height)/2));
        void Settle() {
            transition.Stop();
            stack.Location = Center();
            indicator.Left = tabs[mode].Left;
        }
        transition.Tick += (_,_) => {
            double progress = Math.Clamp(clock.Elapsed.TotalMilliseconds / 200, 0, 1);
            if (progress >= 1 || !WelcomeMotion.Enabled) { Settle(); return; }
            double blend = 1 - Math.Pow(1-progress, 3);
            var target = Center();
            stack.Location = new(target.X, (int)Math.Round(startY + (target.Y-startY)*blend));
            indicator.Left = (int)Math.Round(startX + (tabs[mode].Left-startX)*blend);
        };
        formArea.Resize += (_,_) => Settle();
        stack.SizeChanged += (_,_) => { if (!switching) Settle(); };
        welcome.Disposed += (_,_) => transition.Dispose();
        for (int i=0; i<tabs.Length; i++) {
            int option=i;
            tabs[i].CheckedChanged += (_,_) => {
                if (!tabs[option].Checked) return;
                bool animate = mode != option && Visible && WelcomeMotion.Enabled;
                startY = stack.Top;
                startX = indicator.Left;
                switching = true;
                stack.SuspendLayout();
                mode = option;
                UpdateForm();
                stack.ResumeLayout(true);
                switching = false;
                if (animate) { clock.Restart(); transition.Start(); } else Settle();
            };
        }
        welcome.Controls.Add(formArea,1,0);
        content.Controls.Add(welcome);
        tabs[0].Checked=true; Settle();
        AcceptButton = join; name.Focus();
    }

    void ShowWorkspace()
    {
        status.Visible = true; AcceptButton = null;
        if (content.Controls.Count > 0) content.Controls[0].Dispose(); logs.Clear(); drafts.Clear(); selected = "global"; draft.Clear(); search.Clear();
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new(8) };
        layout.ColumnStyles.Add(new(SizeType.Absolute, 235)); layout.ColumnStyles.Add(new(SizeType.Percent, 100));
        var side = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 5, ColumnCount = 1, Padding = new(16), BackColor = Forest, ForeColor = Paper };
        side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.Percent, 100));
        side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.AutoSize));
        side.Controls.Add(LabelFor("Signed in as " + chat!.Name)); side.Controls.Add(searchField); side.Controls.Add(channels);
        side.Controls.Add(ActionButton("Create or join room", async () =>
        {
            var text = Prompt("Private room", "Enter a room name or a complete invitation.");
            if (text == null || chat == null) return;
            var room = await chat.JoinRoom(text); SelectChannel(room.Id); Populate();
        }));
        side.Controls.Add(ActionButton("Leave space", async () => { await LeaveSpace(); ShowLogin(); }));
        layout.Controls.Add(side, 0, 0);
        conversation = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new(20), BackColor = Color.White };
        conversation.ColumnStyles.Add(new(SizeType.Percent, 100));
        foreach (var style in new RowStyle[] { new(SizeType.AutoSize), new(SizeType.AutoSize), new(SizeType.Absolute, 0), new(SizeType.Percent, 100), new(SizeType.AutoSize) })
            conversation.RowStyles.Add(style);
        conversation.Controls.Add(title);
        var tools = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
        verify = ActionButton("Verify contact", () => { Verify(); return Task.CompletedTask; });
        voice = ActionButton("Voice call", () => Dial(false)); camera = ActionButton("Video call", () => Dial(true));
        accept = ActionButton("Accept call", () => calls!.Accept()); hang = ActionButton("End / decline", () => calls!.End());
        invite = ActionButton("Copy invitation", () => { Clipboard.SetText(chat!.Rooms[selected].Invite); status.Text = "Private invitation copied."; return Task.CompletedTask; });
        tools.Controls.AddRange([verify, voice, camera, accept, hang, invite]); conversation.Controls.Add(tools);
        conversation.Controls.Add(video); conversation.Controls.Add(history);
        var compose = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 2 };
        compose.ColumnStyles.Add(new(SizeType.Percent, 100)); compose.ColumnStyles.Add(new(SizeType.AutoSize));
        send = ActionButton("Send", async () =>
        {
            if (chat == null || sending || string.IsNullOrWhiteSpace(draft.Text)) return;
            var text = draft.Text; var target = selected; sending = true; UpdateActions();
            try
            {
                await chat.Send(target, text.Trim());
                if (selected == target && draft.Text == text) draft.Clear();
                else if (drafts.GetValueOrDefault(target) == text) drafts.Remove(target);
            }
            finally { sending = false; UpdateActions(); }
        });
        send.BackColor = Clay;
        send.ForeColor = Color.White;
        send.Anchor = AnchorStyles.Right;
        compose.Controls.Add(draftField); compose.Controls.Add(send); conversation.Controls.Add(compose);
        layout.Controls.Add(conversation, 1, 0); content.Controls.Add(layout);
        status.Text = "Connected"; Populate(); SelectChannel("global");
    }

    void Populate()
    {
        if (chat == null) return;
        refreshing = true;
        channels.BeginUpdate();
        try
        {
            channels.Items.Clear();
            List<Channel> rows = [new("global", "Global Room", "G")];
            rows.AddRange(chat.Rooms.Values.Select(r => new Channel(r.Id, "# " + r.Label, "#")));
            rows.AddRange(chat.People.Values.Where(p => p.Id != chat.Relay.Id).OrderBy(p => p.Name)
                .Select(p => new Channel(p.Id, p.Name, System.Globalization.StringInfo.GetNextTextElement(p.Name).ToUpperInvariant())));
            foreach (var row in rows.Where(r => r.Label.Contains(search.Text, StringComparison.OrdinalIgnoreCase)))
            {
                int index = channels.Items.Add(row); if (row.Id == selected) channels.SelectedIndex = index;
            }
        }
        finally { channels.EndUpdate(); refreshing = false; }
        UpdateActions();
    }
    void SelectChannel(string id)
    {
        drafts[selected] = draft.Text; selected = id; draft.Text = drafts.GetValueOrDefault(id, "");
        history.Clear();
        if (logs.TryGetValue(id, out var messages))
            foreach (var message in messages) AppendChatLine(message);
        history.SelectionStart = history.TextLength; history.ScrollToCaret(); UpdateActions();
    }
    void AddMessage(string id, string author, string text)
    {
        var line = new ChatLine(DateTime.Now, author, text);
        if (!logs.TryGetValue(id, out var entries)) logs[id] = entries = [];
        entries.Add(line);
        if (id == selected) { AppendChatLine(line); history.ScrollToCaret(); }
    }

    void AppendChatLine(ChatLine line)
    {
        history.Select(history.TextLength, 0);
        if (history.TextLength > 0) history.AppendText("\n\n");
        history.SelectionFont = authorFont;
        history.SelectionColor = Forest;
        history.AppendText(line.Author);
        history.SelectionFont = timeFont;
        history.SelectionColor = Color.FromArgb(85, 99, 91);
        history.AppendText($"    {line.Received:t}\n");
        history.SelectionFont = history.Font;
        history.SelectionColor = Ink;
        history.AppendText(line.Body);
    }
    void UpdateActions()
    {
        if (chat == null || calls == null || send == null) return;
        chat.People.TryGetValue(selected, out var p); chat.Rooms.TryGetValue(selected, out var room);
        title.Text = selected == "global" ? "Global Room" : room != null ? "# " + room.Label : p?.Name ?? "Offline contact";
        verify!.Visible = p != null && !p.Verified;
        voice!.Visible = camera!.Visible = p?.Verified == true;
        voice.Enabled = camera.Enabled = !calls.Busy;
        accept!.Visible = calls.Ringing; hang!.Visible = calls.Busy; invite!.Visible = room != null;
        send.Enabled = !sending && !string.IsNullOrWhiteSpace(draft.Text) && chat.People.ContainsKey(chat.Relay.Id) && (selected == "global" || room != null || p?.Verified == true);
        conversation!.RowStyles[2].Height = calls.VideoActive ? 190 : 0;
    }
    Task Dial(bool videoCall) => chat?.People.TryGetValue(selected, out var p) == true && calls != null ? calls.Dial(p, videoCall) : Task.CompletedTask;
    void Verify()
    {
        if (chat == null || !chat.People.TryGetValue(selected, out var p)) return;
        var entered = Prompt("Verify " + p.Name, "Exchange codes over a separate trusted channel. Enter their code below.", p.OwnCode);
        if (entered == null) return;
        if (!chat.People.TryGetValue(p.Id, out var live) || live != p ||
            !string.Equals(entered.Replace(" ", ""), p.TheirCode.Replace(" ", ""), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Codes differ or the contact has reconnected.");
        p.Verified = true; status.Text = "Device verified."; UpdateActions();
    }
    string? Prompt(string caption, string instruction, string? code = null)
    {
        using var dialog = new Form
        {
            Text = caption,
            ClientSize = new(480, code == null ? 190 : 260),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false,
            MaximizeBox = false
        };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new(16), FlowDirection = FlowDirection.TopDown };
        panel.Controls.Add(new Label { Text = instruction, AutoSize = true, MaximumSize = new(435, 0) });
        if (code != null) panel.Controls.Add(new RoundedField(new TextBox { Text = code, ReadOnly = true, AccessibleName = "Your verification code" }, 435));
        var input = new TextBox { Width = 435, AccessibleName = caption };
        var ok = new Button { Text = "Continue", DialogResult = DialogResult.OK, AutoSize = true };
        panel.Controls.Add(new RoundedField(input, 435)); panel.Controls.Add(ok); dialog.Controls.Add(panel); dialog.AcceptButton = ok;
        dialog.Shown += (_, _) => input.Focus();
        return dialog.ShowDialog(this) == DialogResult.OK ? input.Text.Trim() : null;
    }
    async Task Disconnected() { await LeaveSpace(); if (!closing) { ShowLogin(); status.Text = "Disconnected. Join again to reconnect."; } }
    async Task LeaveSpace()
    {
        var oldChat = chat; var oldCalls = calls; var oldToken = token; chat = null; calls = null; token = null;
        if (oldCalls != null) await oldCalls.End(false);
        oldChat?.Dispose(); logs.Clear(); drafts.Clear(); draft.Clear(); history.Clear();
        if (oldToken != null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/accounts/logout");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", oldToken);
            try { using var response = await http.SendAsync(request); } catch (HttpRequestException) { } catch (TaskCanceledException) { }
        }
    }
}
