using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace CargoSetup;

internal sealed class SetupForm : Form
{
    private readonly SetupOptions _options;
    private readonly float _scale;
    private readonly Timer _animation = new() { Interval = 16 };
    private readonly DateTime _start = DateTime.Now;
    private readonly Font _small = Theme.Body(8.5f);
    private readonly Label _title = new();
    private readonly Label _subtitle = new();
    private readonly Panel _page = new();
    private Action _primaryAction;
    private bool _busy;

    /// <summary>After uninstalling, the uninstaller itself still has to go once the window closes.</summary>
    public bool RemoveSelfOnExit { get; private set; }

    public SetupForm(SetupOptions options)
    {
        _options = options;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) _scale = g.DpiX / 96f;
        using (var stream = Resource("cargo.ico")) Icon = new Icon(stream);

        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(S(700), S(420));
        BackColor = Theme.Background;
        ForeColor = Theme.Text;
        Font = Theme.Body(10f);
        Text = options.Uninstall ? "Uninstall Cargo" : "Cargo Setup";
        KeyPreview = true;
        DoubleBuffered = true;

        var close = new CloseButton { Bounds = new Rectangle(ClientSize.Width - S(50), S(10), S(40), S(32)) };
        close.Click += (_, _) => Close();
        _title.SetBounds(S(300), S(52), S(370), S(52));
        _title.Font = Theme.Display(24f);
        _title.ForeColor = Theme.Text;
        _subtitle.SetBounds(S(302), S(106), S(360), S(64));
        _subtitle.Font = Theme.Body(10.5f);
        _subtitle.ForeColor = Theme.Muted;
        _page.SetBounds(S(302), S(178), S(360), S(222));
        Controls.AddRange(new Control[] { close, _title, _subtitle, _page });

        // The scan line sweeps over the container, like Cargo scanning a project.
        _animation.Tick += (_, _) => Invalidate(new Rectangle(0, 0, S(260), ClientSize.Height - S(48)));
        _animation.Start();

        if (options.Uninstall) ShowUninstall();
        else if (options.Update) Shown += (_, _) => StartInstall();
        else ShowWelcome();
    }

    private int S(int value) => (int)Math.Round(value * _scale);

    /// <summary>Shortens text from the middle until it fits, so the start and the end of a path stay readable.</summary>
    private static string CompactPath(string text, Font font, int width)
    {
        if (TextRenderer.MeasureText(text, font).Width <= width) return text;
        int middle = text.Length / 2;
        for (int remove = 4; remove < text.Length - 12; remove += 2)
        {
            string candidate = text.Substring(0, middle - remove / 2) + "…" + text.Substring(middle + (remove + 1) / 2);
            if (TextRenderer.MeasureText(candidate, font).Width <= width) return candidate;
        }
        return text;
    }

    private static Stream Resource(string name) => Assembly.GetExecutingAssembly().GetManifestResourceStream(name);

    // ---------- install pages ----------
    private void ShowWelcome()
    {
        _page.Controls.Clear();
        _title.Text = "Cargo";
        _subtitle.Text = "Scans After Effects projects without After Effects, finds what's unused or missing, and packages everything they need.";

        bool installed = Installer.IsInstalled(_options.Folder);
        var desktop = new CheckOption { Text = "Add a desktop shortcut", Checked = _options.DesktopShortcut, Bounds = new Rectangle(0, 0, S(360), S(28)) };
        // One line, shortened in the middle if the path is long, with the full path on hover
        var folder = new Label
        {
            Text = CompactPath($"Installs to {_options.Folder}", _small, S(360)), AutoSize = false, Bounds = new Rectangle(0, S(46), S(360), S(20)),
            Font = _small, ForeColor = Theme.Faint,
        };
        new ToolTip().SetToolTip(folder, _options.Folder);
        var change = Link("Change folder", 0, S(68), ChooseFolder);

        string noteText = installed
            ? "Cargo is already installed here and gets updated. Your settings, tags and history stay as they are."
            : "No admin rights needed.";
        if (Installer.IsRunning(_options.Folder)) noteText += " Cargo is running and will be closed first.";
        if (!Installer.HasPayload) noteText = "This setup file is incomplete. Download it again from the Cargo page on GitHub.";
        var note = SmallLabel(noteText, 0, S(112));
        note.ForeColor = Theme.Muted;

        var install = new FlatButton { Primary = true, Text = installed ? "Update" : "Install", Bounds = new Rectangle(S(240), S(178), S(120), S(40)), Enabled = Installer.HasPayload };
        var cancel = new FlatButton { Text = "Cancel", Bounds = new Rectangle(S(130), S(178), S(100), S(40)) };
        _primaryAction = () =>
        {
            if (!install.Enabled) return;
            _options.DesktopShortcut = desktop.Checked;
            StartInstall();
        };
        install.Click += (_, _) => _primaryAction();
        cancel.Click += (_, _) => Close();
        _page.Controls.AddRange(new Control[] { desktop, folder, change, note, install, cancel });
        install.Select();
    }

    private async void StartInstall()
    {
        var bar = _options.Update
            ? ShowProgress("Updating Cargo", $"Installing version {Installer.Version}. Cargo opens again when it's done.")
            : ShowProgress("Installing", "This takes a few seconds.");
        try
        {
            await Task.Run(() => Installer.Install(_options, bar));
            _busy = false;
            if (_options.Update)
            {
                Installer.Launch(_options.Folder);
                Close();
                return;
            }
            ShowDone();
        }
        catch (Exception ex)
        {
            _busy = false;
            ShowError(ex.Message, "Setup couldn't finish. Your projects and footage were not touched.");
        }
    }

    private void ShowDone()
    {
        _page.Controls.Clear();
        _title.Text = "All set";
        _subtitle.Text = "Open Cargo from the Start menu, then drop an .aep onto its window to see every file the project uses.";

        var open = new FlatButton { Primary = true, Text = "Open Cargo", Bounds = new Rectangle(S(220), S(178), S(140), S(40)) };
        var close = new FlatButton { Text = "Close", Bounds = new Rectangle(S(110), S(178), S(100), S(40)) };
        _primaryAction = () =>
        {
            Installer.Launch(_options.Folder);
            Close();
        };
        open.Click += (_, _) => _primaryAction();
        close.Click += (_, _) => Close();
        _page.Controls.AddRange(new Control[] { open, close });
        open.Select();
    }

    // ---------- uninstall pages ----------
    private void ShowUninstall()
    {
        _page.Controls.Clear();
        _title.Text = "Uninstall Cargo";
        _subtitle.Text = "Cargo is removed from this PC. Your projects, footage and packages stay exactly where they are.";

        bool installed = Installer.IsInstalled(_options.Folder);
        var purge = new CheckOption { Text = "Also remove settings, tags and history", Checked = _options.RemoveUserData, Bounds = new Rectangle(0, 0, S(360), S(28)) };
        var note = SmallLabel(installed
            ? (Installer.IsRunning(_options.Folder) ? "Cargo is running and will be closed first." : "Only Cargo's own files are removed.")
            : "Cargo isn't installed in this folder, so there's nothing to remove.", 0, S(40));
        note.ForeColor = Theme.Muted;

        var remove = new FlatButton { Primary = true, Danger = true, Text = "Uninstall", Bounds = new Rectangle(S(240), S(178), S(120), S(40)), Enabled = installed };
        var cancel = new FlatButton { Text = "Cancel", Bounds = new Rectangle(S(130), S(178), S(100), S(40)) };
        _primaryAction = () =>
        {
            if (!remove.Enabled) return;
            _options.RemoveUserData = purge.Checked;
            StartUninstall();
        };
        remove.Click += (_, _) => _primaryAction();
        cancel.Click += (_, _) => Close();
        _page.Controls.AddRange(new Control[] { purge, note, remove, cancel });
        cancel.Select();
    }

    private async void StartUninstall()
    {
        var bar = ShowProgress("Uninstalling", "Closing Cargo and removing its files.");
        try
        {
            await Task.Run(() => Installer.Uninstall(_options, bar));
            _busy = false;
            RemoveSelfOnExit = true;
            _page.Controls.Clear();
            _title.Text = "Cargo is uninstalled";
            _subtitle.Text = _options.RemoveUserData
                ? "Its files, settings and history are gone. Your projects and footage are untouched."
                : "Its files are gone. Settings and history were kept in case you come back.";
            var close = new FlatButton { Primary = true, Text = "Close", Bounds = new Rectangle(S(240), S(178), S(120), S(40)) };
            close.Click += (_, _) => Close();
            _primaryAction = Close;
            _page.Controls.Add(close);
            close.Select();
        }
        catch (Exception ex)
        {
            _busy = false;
            ShowError(ex.Message, "Cargo couldn't be removed completely. Your projects and footage were not touched.");
        }
    }

    // ---------- shared ----------
    private Action<double, string> ShowProgress(string title, string subtitle)
    {
        _busy = true;
        _primaryAction = null;
        _page.Controls.Clear();
        _title.Text = title;
        _subtitle.Text = subtitle;
        var status = new Label { Text = "Getting ready", AutoSize = true, Location = new Point(0, S(20)), Font = Theme.Strong(10.5f), ForeColor = Theme.Text };
        var bar = new ThinProgress { Bounds = new Rectangle(0, S(56), S(360), S(6)) };
        var percent = SmallLabel("0%", 0, S(72));
        _page.Controls.AddRange(new Control[] { status, bar, percent });
        return (value, text) => BeginInvoke((Action)(() =>
        {
            bar.Value = value;
            status.Text = text;
            percent.Text = $"{(int)(value * 100)}%";
        }));
    }

    private void ShowError(string message, string subtitle)
    {
        _page.Controls.Clear();
        _title.Text = "That didn't work";
        _subtitle.Text = subtitle;
        var detail = SmallLabel(message, 0, 0);
        detail.ForeColor = Theme.Muted;
        var close = new FlatButton { Primary = true, Text = "Close", Bounds = new Rectangle(S(240), S(178), S(120), S(40)) };
        close.Click += (_, _) => Close();
        _primaryAction = Close;
        _page.Controls.AddRange(new Control[] { detail, close });
    }

    private void ChooseFolder()
    {
        using var dialog = new FolderBrowserDialog { Description = "Where should Cargo be installed?", SelectedPath = Path.GetDirectoryName(_options.Folder) };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        string path = dialog.SelectedPath;
        _options.Folder = path.EndsWith("Cargo", StringComparison.OrdinalIgnoreCase) ? path : Path.Combine(path, "Cargo");
        ShowWelcome();
    }

    private Label SmallLabel(string text, int x, int y) => new()
    {
        Text = text, AutoSize = true, MaximumSize = new Size(S(360), 0), Location = new Point(x, y), Font = _small, ForeColor = Theme.Faint,
    };

    private LinkLabel Link(string text, int x, int y, Action onClick)
    {
        var link = new LinkLabel
        {
            Text = text, AutoSize = true, Location = new Point(x, y), Font = _small,
            LinkColor = Theme.Text, ActiveLinkColor = Theme.Accent, VisitedLinkColor = Theme.Text, LinkBehavior = LinkBehavior.HoverUnderline,
        };
        link.LinkClicked += (_, _) => onClick();
        return link;
    }

    // ---------- window ----------
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2; // DWMWCP_ROUND, Windows 11 only
        DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

        var art = new Rectangle(0, 0, S(260), ClientSize.Height);
        using (var brush = new SolidBrush(Theme.Panel)) g.FillRectangle(brush, art);

        // Faster sweep while working, a calm one otherwise.
        double t = (DateTime.Now - _start).TotalSeconds * (_busy ? 2.4 : 0.9);
        float scan = (float)Math.Sin(t);
        int size = S(168);
        var dest = new RectangleF((art.Width - size) / 2f, (art.Height - size) / 2f - S(12), size, size);
        CargoMark.Draw(g, dest, scan);

        TextRenderer.DrawText(g, $"Version {Installer.Version}", _small, new Point(S(22), ClientSize.Height - S(34)), Theme.Faint);

        using var pen = new Pen(Theme.Line);
        g.DrawLine(pen, art.Right, 0, art.Right, ClientSize.Height);
        g.DrawRectangle(pen, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        ReleaseCapture();
        SendMessage(Handle, 0xA1 /* WM_NCLBUTTONDOWN */, (IntPtr)2 /* HTCAPTION */, IntPtr.Zero);
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Escape) Close();
        else if (e.KeyCode == Keys.Enter && _primaryAction != null && !(ActiveControl is CheckOption)) _primaryAction();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (_busy) e.Cancel = true; // half copied files would help nobody
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _animation.Dispose();
            _small.Dispose();
        }
        base.Dispose(disposing);
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
}
