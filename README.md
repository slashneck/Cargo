<p align="center">
  <img src="docs/banner.png" alt="Cargo" width="100%">
</p>

<p align="center">
  <a href="https://github.com/slashneck/Cargo/releases/latest"><img src="https://img.shields.io/github/v/release/slashneck/Cargo?style=flat-square&label=release&color=f4f4f4&labelColor=161616" alt="Latest release"></a>
  <a href="https://github.com/slashneck/Cargo/releases"><img src="https://img.shields.io/github/downloads/slashneck/Cargo/total?style=flat-square&color=f4f4f4&labelColor=161616" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%26%2011-f4f4f4?style=flat-square&labelColor=161616" alt="Windows 10 and 11">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f4f4f4?style=flat-square&labelColor=161616" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://github.com/slashneck/Cargo/releases/latest"><b>Download for Windows</b></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#features">Features</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#packaging">Packaging</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#building">Build it yourself</a>
</p>

<br>

Cargo opens After Effects projects without After Effects and shows you every file they use. Drop an `.aep` on it and
you see which footage is used, which is dead weight and which is missing. Then package the project for a client,
archive it to another drive, or clean up what you don't need anymore.

## Features

**Every file at a glance.** Footage, audio, image sequences, stills, graphics and data files, with size, resolution,
duration, frame rate and where they sit in your project panel. Thumbnails and a preview for images, video and audio.
Search, filter by type or status and sort however you like, even with thousands of items.

**Used, unused, missing.** An item counts as used when a layer in any composition uses it. Data files that are only read
by expressions (`footage("scores.json")`) count too. Green is used, yellow is used but missing, red is unused. For every
file you see which comps use it, and for every comp which files it pulls in, through all its precomps.

**Find missing footage.** Cargo looks on your other drives, around the project and in folders you add, lets you confirm
each match or pick the file yourself, and saves a relinked copy of the project.

**Clean up.** Send unused files to the Recycle Bin, or tick any files you like, or clear out all of a project's media in
one go. Favorites, files tagged `keep` and footage another open project still needs are never picked for you.
**Organize** sorts the footage into tidy folders and saves a project that points to them. **Archive** copies a finished
project with all its footage to another drive, checks the copy, and can then remove the originals.

**Insights.** How big the project really is, how much you'd save by deleting what's unused, how long it takes to send,
the largest files, and which comps are the heaviest. The effects tab lists every plugin the project needs, with
third-party ones flagged.

**More.** Duplicate finder, batch scanning of whole folders (auto-saves are skipped), manifests as PDF, text, CSV or
JSON, tags and favorites, and a history of everything you packaged.

## Packaging

Package Project writes a zip or a folder named `Project_Package_YYYY-MM-DD` with the project, its footage sorted by type
or by your project folders, a `MANIFEST.txt` and a `Relink Footage.jsx` script. Unused footage stays out unless you want
it, and a single composition can be packaged on its own.

Packages are **private** by default. File paths inside an `.aep` contain your user name and folder structure, and its
metadata keeps a save history with times. A private package points every path to a neutral folder named after the
package, removes that history, and keeps paths, dates and version info out of the manifest. Extract it to `C:\` and
After Effects finds everything, or open it anywhere and run `Relink Footage.jsx` (File › Scripts › Run Script File).

Your original project is never changed. Packages, archives and relinks always write new files.

## Install

Download `CargoSetup` from the [latest release](https://github.com/slashneck/Cargo/releases/latest) and run it. It
installs for your Windows account only, so no admin rights are needed, and it keeps itself up to date.

The setup isn't code signed yet, so Windows SmartScreen may say it "protected your PC". Click **More info** and then
**Run anyway**. Every release lists the SHA-256 checksum of its files. If you'd rather not install anything, the
`win-x64.zip` is a portable version: unzip it anywhere and run `Cargo.exe`.

You need Windows 10 or 11, 64 bit.

## Where your files are

| What | Where |
| --- | --- |
| Settings, tags, recent projects and history | `%AppData%\Cargo` |
| The program | `%LocalAppData%\Programs\Cargo` |

Deleted files go to the Recycle Bin. Uninstalling removes the program and keeps your settings, unless you tick the box
to remove them too.

## Updates

When Cargo starts, it asks GitHub whether a newer version exists. If there is one, you can install it from inside Cargo:
the new setup is downloaded, checked against its SHA-256 checksum and run. You can switch the check off under Help.

## Good to know

- Fonts aren't packaged, and neither are plugins. The manifest lists both so whoever opens the project knows what to install.
- Delete Unused removes files, not project items. In After Effects, File › Dependencies › Remove Unused Footage tidies up
  the project itself.
- Projects saved on a Mac have `/Volumes/...` paths and show as missing on Windows until you run Find Missing.
- If Cargo reads a project wrong, please [open an issue](https://github.com/slashneck/Cargo/issues) with the After Effects
  version. A small sample project helps most. [docs/aep-format.md](docs/aep-format.md) explains how Cargo reads `.aep` files.

## Building

You need Node.js 20 or newer, and the .NET 8 SDK for the setup.

```powershell
npm install
npm start            # run Cargo
npm test             # parser, packaging and cleanup tests
.\build-release.ps1  # setup, portable zip, checksums and source zip in dist
```

`node scripts/demo-project.js "<folder>"` creates a small demo project with real footage, a missing file, unused files
and a duplicate to try things on.

## License

Copyright (c) 2026 slashneck. Cargo is free software under the [MIT License](LICENSE).
