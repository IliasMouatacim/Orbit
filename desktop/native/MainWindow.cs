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
    static readonly Uri Server = new("https://chattingapp-n4ig.onrender.com");
    readonly HttpClient http = new() { BaseAddress = Server, Timeout = TimeSpan.FromSeconds(45) };
    readonly Label status = new() { Dock = DockStyle.Bottom, AutoSize = false, Height = 34, Padding = new(12, 7, 0, 0) };
    readonly Panel content = new() { Dock = DockStyle.Fill };
    readonly PictureBox video = new() { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.FromArgb(23, 35, 32) };
    readonly ListBox channels = new() { Dock = DockStyle.Fill, IntegralHeight = false, BorderStyle = BorderStyle.None };
    readonly TextBox search = new() { Dock = DockStyle.Top, PlaceholderText = "Find people or rooms" };
    readonly RichTextBox history = new() { Dock = DockStyle.Fill, ReadOnly = true, DetectUrls = false, BorderStyle = BorderStyle.None, BackColor = Color.White };
    readonly TextBox draft = new() { Dock = DockStyle.Fill, MaxLength = 500, PlaceholderText = "Write a message" };
    readonly Label title = new() { AutoSize = true, Font = new("Segoe UI", 16, FontStyle.Bold) };
    readonly Dictionary<string, List<string>> logs = [];
    readonly Dictionary<string, string> drafts = [];
    Chat? chat;
    Calls? calls;
    string? token;
    string selected = "global";
    bool refreshing, sending, closing;
    Button? send, verify, voice, camera, accept, hang, invite;
    TableLayoutPanel? conversation;
    record Channel(string Id, string Label) { public override string ToString() => Label; }

    public MainWindow()
    {
        Text = "Orbit Chat"; StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new(760, 520); Size = new(1050, 720); Font = new("Segoe UI", 10);
        BackColor = Color.FromArgb(244, 246, 241);
        Controls.Add(content); Controls.Add(status);
        channels.SelectedIndexChanged += (_, _) =>
        {
            if (!refreshing && channels.SelectedItem is Channel row) SelectChannel(row.Id);
        };
        search.TextChanged += (_, _) => Populate();
        draft.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; send?.PerformClick(); } };
        FormClosing += (_, e) =>
        {
            if (closing) return;
            e.Cancel = true; closing = true;
            BeginInvoke(async () => { try { await LeaveSpace(); } finally { Close(); } });
        };
        Shown += (_, _) => ShowLogin();
    }

    static Button ActionButton(string caption, Func<Task> action)
    {
        var b = new Button { Text = caption, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new(8, 4, 8, 4), FlatStyle = FlatStyle.System };
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
        var stack = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new(44), FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
        stack.Controls.Add(new Label { Text = "Orbit", Font = new("Segoe UI", 28, FontStyle.Bold), AutoSize = true });
        var mode = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 310 };
        mode.Items.AddRange(["Join as guest", "Sign in", "Create account"]); mode.SelectedIndex = 0;
        var name = new TextBox { Width = 310, MaxLength = 254 };
        var password = new TextBox { Width = 310, UseSystemPasswordChar = true, MaxLength = 256 };
        var email = new TextBox { Width = 310, MaxLength = 254 };
        var who = LabelFor("Display name"); var pass = LabelFor("Password"); var address = LabelFor("Email (optional)");
        stack.Controls.AddRange([LabelFor("Access"), mode, who, name, pass, password, address, email]);
        Button? join = null;
        join = ActionButton("Continue", async () =>
        {
            if (!stack.Enabled || string.IsNullOrWhiteSpace(name.Text)) return;
            stack.Enabled = false; status.Text = "Connecting…";
            Chat? next = null;
            try
            {
                next = new Chat();
                string handle = name.Text.Trim();
                if (mode.SelectedIndex == 0 && (handle.Length > 24 || handle.StartsWith('@'))) throw new ArgumentException("Choose a guest name of up to 24 characters without a leading @.");
                if (mode.SelectedIndex != 0)
                {
                    using var response = await http.PostAsJsonAsync(mode.SelectedIndex == 1 ? "/accounts/login" : "/accounts/register",
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
            finally { stack.Enabled = true; }
        });
        mode.SelectedIndexChanged += (_, _) => Mode();
        void Mode()
        {
            password.Visible = pass.Visible = mode.SelectedIndex != 0;
            email.Visible = address.Visible = mode.SelectedIndex == 2;
            who.Text = mode.SelectedIndex switch { 1 => "Username or email", 2 => "Username", _ => "Display name" };
        }
        stack.Controls.Add(join); content.Controls.Add(stack); AcceptButton = join; Mode(); name.Focus();
    }

    void ShowWorkspace()
    {
        AcceptButton = null; content.Controls.Clear(); logs.Clear(); drafts.Clear(); selected = "global"; draft.Clear(); search.Clear();
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Padding = new(8) };
        layout.ColumnStyles.Add(new(SizeType.Absolute, 235)); layout.ColumnStyles.Add(new(SizeType.Percent, 100));
        var side = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 5, ColumnCount = 1, Padding = new(8) };
        side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.Percent, 100));
        side.RowStyles.Add(new(SizeType.AutoSize)); side.RowStyles.Add(new(SizeType.AutoSize));
        side.Controls.Add(LabelFor("Signed in as " + chat!.Name)); side.Controls.Add(search); side.Controls.Add(channels);
        side.Controls.Add(ActionButton("Create or join room", async () =>
        {
            var text = Prompt("Private room", "Enter a room name or a complete invitation.");
            if (text == null || chat == null) return;
            var room = await chat.JoinRoom(text); SelectChannel(room.Id); Populate();
        }));
        side.Controls.Add(ActionButton("Leave space", async () => { await LeaveSpace(); ShowLogin(); }));
        layout.Controls.Add(side, 0, 0);
        conversation = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new(12), BackColor = Color.White };
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
        compose.Controls.Add(draft); compose.Controls.Add(send); conversation.Controls.Add(compose);
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
            List<Channel> rows = [new("global", "Global Room")];
            rows.AddRange(chat.Rooms.Values.Select(r => new Channel(r.Id, "# " + r.Label)));
            rows.AddRange(chat.People.Values.Where(p => p.Id != chat.Relay.Id).OrderBy(p => p.Name)
                .Select(p => new Channel(p.Id, p.Name)));
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
        history.Text = string.Join(Environment.NewLine, logs.GetValueOrDefault(id) ?? []);
        history.SelectionStart = history.TextLength; history.ScrollToCaret(); UpdateActions();
    }
    void AddMessage(string id, string author, string text)
    {
        var line = $"{DateTime.Now:t}   {author}    {text}";
        if (!logs.TryGetValue(id, out var entries)) logs[id] = entries = [];
        entries.Add(line);
        if (id == selected) { history.AppendText((history.TextLength > 0 ? Environment.NewLine : "") + line); history.ScrollToCaret(); }
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
        send.Enabled = !sending && chat.People.ContainsKey(chat.Relay.Id) && (selected == "global" || room != null || p?.Verified == true);
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
            ClientSize = new(480, code == null ? 155 : 215),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false,
            MaximizeBox = false
        };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new(16), FlowDirection = FlowDirection.TopDown };
        panel.Controls.Add(new Label { Text = instruction, AutoSize = true, MaximumSize = new(435, 0) });
        if (code != null) panel.Controls.Add(new TextBox { Text = code, ReadOnly = true, Width = 435, AccessibleName = "Your verification code" });
        var input = new TextBox { Width = 435, AccessibleName = caption };
        var ok = new Button { Text = "Continue", DialogResult = DialogResult.OK, AutoSize = true };
        panel.Controls.Add(input); panel.Controls.Add(ok); dialog.Controls.Add(panel); dialog.AcceptButton = ok;
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
