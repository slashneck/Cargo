using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace CargoSetup;

/// <summary>
/// Copies Cargo into a per-user folder. Only files named in Cargo's file list are ever replaced or removed, so
/// nothing else in the folder is touched, and neither are projects, footage or packages anywhere on the PC.
/// </summary>
internal static class Installer
{
    public const string ManifestName = "cargo-files.txt";
    public const string ExeName = "Cargo.exe";
    public const string UninstallerName = "Uninstall Cargo.exe";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Cargo";
    private const string RepoUrl = "https://github.com/slashneck/Cargo";

    public static string DefaultFolder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Cargo");

    /// <summary>Where the app keeps its settings, recent projects and history.</summary>
    public static string UserDataFolder =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Cargo");

    public static string Version
    {
        get
        {
            var v = Assembly.GetExecutingAssembly().GetName().Version;
            return $"{v.Major}.{v.Minor}.{v.Build}";
        }
    }

    public static bool HasPayload => Assembly.GetExecutingAssembly().GetManifestResourceNames().Contains("payload.zip");

    public static bool IsInstalled(string folder) => File.Exists(Path.Combine(folder, ManifestName));

    public static bool IsRunning(string folder)
    {
        var copies = RunningCopies(folder);
        copies.ForEach(p => p.Dispose());
        return copies.Count > 0;
    }

    public static void Install(SetupOptions options, Action<double, string> report)
    {
        if (!HasPayload) throw new InvalidOperationException("This setup doesn't contain Cargo. Download the full setup from GitHub.");
        string folder = options.Folder;

        report?.Invoke(0, "Closing Cargo");
        StopRunningCopies(folder);

        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
        {
            var manifest = zip.GetEntry(ManifestName) ?? throw new InvalidDataException("The setup is damaged: its file list is missing.");
            List<string> newFiles;
            using (var reader = new StreamReader(manifest.Open(), Encoding.UTF8)) newFiles = ParseManifest(reader.ReadToEnd());
            var oldFiles = IsInstalled(folder) ? ParseManifest(File.ReadAllText(Path.Combine(folder, ManifestName))) : new List<string>();

            Directory.CreateDirectory(folder);
            report?.Invoke(0.02, "Removing old files");
            foreach (string rel in oldFiles.Except(newFiles, StringComparer.OrdinalIgnoreCase))
                Retry(() => { string path = Path.Combine(folder, rel); if (File.Exists(path)) File.Delete(path); });

            var entries = zip.Entries.Where(e => e.Name.Length > 0).ToList();
            long total = Math.Max(1, entries.Sum(e => e.Length)), done = 0;
            foreach (var entry in entries)
            {
                string target = Path.Combine(folder, CheckRelative(entry.FullName));
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                Retry(() =>
                {
                    using (var input = entry.Open())
                    using (var output = File.Create(target))
                        input.CopyTo(output);
                });
                done += entry.Length;
                report?.Invoke(0.05 + 0.85 * done / total, "Copying files");
            }
        }
        RemoveEmptyFolders(folder);

        string exe = Path.Combine(folder, ExeName);
        report?.Invoke(0.94, "Adding shortcuts");
        if (options.StartMenuShortcut) CreateShortcut(StartMenuShortcut, exe);
        if (options.DesktopShortcut) CreateShortcut(DesktopShortcut, exe);
        if (options.Register) Register(folder, exe);
        report?.Invoke(1, "Done");
    }

    /// <summary>Removes the program. Projects, footage and packages are never touched; settings only with /purge.</summary>
    public static void Uninstall(SetupOptions options, Action<double, string> report)
    {
        string folder = options.Folder;
        if (!IsInstalled(folder)) throw new InvalidOperationException("Cargo isn't installed in this folder, so there's nothing to remove.");

        report?.Invoke(0, "Closing Cargo");
        StopRunningCopies(folder);

        report?.Invoke(0.1, "Removing shortcuts");
        foreach (string shortcut in new[] { StartMenuShortcut, DesktopShortcut })
        {
            try { if (IsOurShortcut(shortcut, folder)) File.Delete(shortcut); } catch { }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, throwOnMissingSubKey: false); } catch { }

        string self = Path.GetFullPath(System.Windows.Forms.Application.ExecutablePath);
        var files = ParseManifest(File.ReadAllText(Path.Combine(folder, ManifestName)));
        for (int i = 0; i < files.Count; i++)
        {
            string path = Path.Combine(folder, files[i]);
            if (!path.Equals(self, StringComparison.OrdinalIgnoreCase)) DeleteWithRetry(path);
            report?.Invoke(0.15 + 0.75 * (i + 1) / files.Count, "Removing files");
        }
        DeleteWithRetry(Path.Combine(folder, ManifestName));
        RemoveEmptyFolders(folder);

        if (options.RemoveUserData)
        {
            report?.Invoke(0.95, "Removing settings and history");
            try { if (Directory.Exists(UserDataFolder)) Directory.Delete(UserDataFolder, recursive: true); } catch { }
        }
        report?.Invoke(1, "Done");
    }

    /// <summary>A running exe can't delete itself, so a short-lived cmd removes it and the then empty folder.</summary>
    public static void ScheduleSelfRemoval(string folder)
    {
        string self = Path.GetFullPath(System.Windows.Forms.Application.ExecutablePath);
        if (!self.StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return;
        Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping 127.0.0.1 -n 3 >nul & del /f /q \"{self}\" & rd \"{folder}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath(),
        });
    }

    public static void Launch(string folder)
    {
        string exe = Path.Combine(folder, ExeName);
        if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = folder });
    }

    public static bool HasDesktopShortcut(string folder) => IsOurShortcut(DesktopShortcut, folder);

    private static string StartMenuShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Cargo.lnk");
    private static string DesktopShortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Cargo.lnk");

    private static void StopRunningCopies(string folder)
    {
        // Electron runs several Cargo.exe processes (window, renderer, GPU); close them all.
        foreach (var proc in RunningCopies(folder))
        {
            using (proc)
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(5000);
                }
                catch { }
            }
        }
    }

    private static List<Process> RunningCopies(string folder)
    {
        string prefix = folder.TrimEnd('\\') + "\\";
        var result = new List<Process>();
        foreach (var proc in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
        {
            string path = null;
            try { path = proc.MainModule?.FileName; } catch { }
            if (path != null && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) result.Add(proc);
            else proc.Dispose();
        }
        return result;
    }

    private static List<string> ParseManifest(string text) =>
        text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(l => l.Trim()).Where(l => l.Length > 0).Select(CheckRelative).ToList();

    private static string CheckRelative(string path)
    {
        string rel = path.Replace('/', '\\');
        if (Path.IsPathRooted(rel) || rel.Split('\\').Contains("..")) throw new InvalidDataException($"Unexpected file in the setup: {path}");
        return rel;
    }

    private static void Retry(Action action)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                action();
                return;
            }
            catch (Exception ex) when ((ex is IOException || ex is UnauthorizedAccessException) && attempt < 40)
            {
                Thread.Sleep(250); // a closing Cargo or an antivirus scan can hold a file for a moment
            }
        }
    }

    private static void DeleteWithRetry(string path)
    {
        try { Retry(() => { if (File.Exists(path)) File.Delete(path); }); } catch { }
    }

    private static void RemoveEmptyFolders(string root)
    {
        if (!Directory.Exists(root)) return;
        foreach (string dir in Directory.GetDirectories(root, "*", SearchOption.AllDirectories).OrderByDescending(d => d.Length))
        {
            try { if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir); } catch { }
        }
    }

    private static void Register(string folder, string exe)
    {
        long kb = new DirectoryInfo(folder).GetFiles("*", SearchOption.AllDirectories).Sum(f => f.Length) / 1024;
        string uninstaller = Path.Combine(folder, UninstallerName);
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", "Cargo");
            key.SetValue("DisplayVersion", Version);
            key.SetValue("Publisher", "Cargo");
            key.SetValue("DisplayIcon", exe);
            key.SetValue("InstallLocation", folder);
            key.SetValue("UninstallString", $"\"{uninstaller}\" --uninstall");
            key.SetValue("QuietUninstallString", $"\"{uninstaller}\" --uninstall /silent");
            key.SetValue("URLInfoAbout", RepoUrl);
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, kb), RegistryValueKind.DWord);
        }
    }

    private static void CreateShortcut(string path, string target)
    {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(target);
        link.SetWorkingDirectory(Path.GetDirectoryName(target));
        link.SetIconLocation(target, 0);
        link.SetDescription("Cargo — After Effects project scanner & packager");
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        ((IPersistFile)link).Save(path, false);
        Marshal.ReleaseComObject(link);
    }

    /// <summary>Only remove shortcuts that point into this install, never one the user made for another copy.</summary>
    private static bool IsOurShortcut(string path, string folder)
    {
        if (!File.Exists(path)) return false;
        var link = (IShellLinkW)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(1024);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            return target.ToString().StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int max, IntPtr findData, int flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int max);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int max);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int max);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int max, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }
}
