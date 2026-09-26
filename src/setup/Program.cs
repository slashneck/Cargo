using System;
using System.IO;
using System.Windows.Forms;

namespace CargoSetup;

internal sealed class SetupOptions
{
    public string Folder = Installer.DefaultFolder;
    public bool DesktopShortcut = true;
    public bool StartMenuShortcut = true;
    public bool Register = true;
    public bool Silent;
    public bool Uninstall;
    public bool Update;
    public bool RemoveUserData;

    /// <summary>
    /// /silent installs without a window, /dir="C:\path" picks the folder, /noshortcuts and /noregister leave the Start
    /// menu, desktop and "Installed apps" alone (handy for testing). /update is how Cargo installs a new version: it
    /// keeps the shortcuts as they are and starts Cargo again. --uninstall removes Cargo from the folder the
    /// uninstaller sits in (or /dir), and /purge also removes Cargo's settings and history.
    /// </summary>
    public static SetupOptions Parse(string[] args)
    {
        var options = new SetupOptions();
        bool dirGiven = false;
        foreach (string raw in args)
        {
            string arg = raw.TrimStart('/', '-');
            if (arg.StartsWith("dir=", StringComparison.OrdinalIgnoreCase))
            {
                options.Folder = Path.GetFullPath(arg.Substring(4).Trim('"'));
                dirGiven = true;
            }
            else if (arg.Equals("silent", StringComparison.OrdinalIgnoreCase)) options.Silent = true;
            else if (arg.Equals("noshortcuts", StringComparison.OrdinalIgnoreCase)) options.DesktopShortcut = options.StartMenuShortcut = false;
            else if (arg.Equals("noregister", StringComparison.OrdinalIgnoreCase)) options.Register = false;
            else if (arg.Equals("uninstall", StringComparison.OrdinalIgnoreCase)) options.Uninstall = true;
            else if (arg.Equals("purge", StringComparison.OrdinalIgnoreCase)) options.RemoveUserData = true;
            else if (arg.Equals("update", StringComparison.OrdinalIgnoreCase)) options.Update = true;
        }
        // The uninstaller lives inside the install folder.
        if (options.Uninstall && !dirGiven) options.Folder = Path.GetDirectoryName(Application.ExecutablePath);
        // An update keeps whatever shortcuts the first install made.
        if (options.Update) options.DesktopShortcut = Installer.HasDesktopShortcut(options.Folder);
        return options;
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var options = SetupOptions.Parse(args);
        if (options.Silent)
        {
            try
            {
                if (options.Uninstall)
                {
                    Installer.Uninstall(options, null);
                    Installer.ScheduleSelfRemoval(options.Folder);
                }
                else
                {
                    Installer.Install(options, null);
                    if (options.Update) Installer.Launch(options.Folder);
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new SetupForm(options);
        Application.Run(form);
        if (form.RemoveSelfOnExit) Installer.ScheduleSelfRemoval(options.Folder);
        return 0;
    }
}
