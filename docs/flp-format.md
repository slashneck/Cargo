# How Cargo reads .flp files

An FL Studio project is an `FLhd` header followed by an `FLdt` chunk holding a flat stream of events. Every event starts with a one-byte id:

| Id | Data |
| --- | --- |
| 0–63 | 1 byte |
| 64–127 | 2 bytes |
| 128–191 | 4 bytes |
| 192–255 | a varint length, then that many bytes (text and structures) |

Text is UTF-16 since FL Studio 11.5 and ANSI before. Like the `.aep` reader, Cargo keeps the byte range of every event. An untouched project writes back to the identical file, and only edited events are rebuilt. All 161 projects that ship with FL Studio 2025 (saved by FL Studio 10.9 to 25.2) round-trip byte for byte.

## Events Cargo uses

| Id | Meaning |
| --- | --- |
| 199 | FL Studio version (ASCII) |
| 64 | a channel starts (value: channel id) |
| 21 | channel type |
| 196 | channel sample path |
| 94 | child channel of a layer |
| 201 / 203 | plugin internal name / display name |
| 213 | plugin state. For VSTs ("Fruity Wrapper") it holds sub-records: 54 name, 55 file, 56 vendor |
| 65 | a pattern starts |
| 224 | pattern notes, 24 bytes each, channel id at offset 6 |
| 99 | an arrangement starts |
| 233 | playlist items |
| 236 | a mixer insert (everything after the first one is the mixer) |
| 98 | a mixer slot ends |
| 200 | licensee |
| 202 | project data folder |
| 237 | creation date and time spent |

Playlist items are 32 bytes up to FL Studio 20.8, 60 bytes from 20.99 and 80 bytes from 24.2. Each one holds 20480 at offset 4 and an index at offset 6. An index at or below 20480 is a channel (audio and automation clips); above it, it's a pattern (index − 20480). Cargo picks the size by version and checks it against that marker.

## Sample paths

Paths can start with placeholders:

| Placeholder | Folder |
| --- | --- |
| `%FLStudioFactoryData%` | the FL Studio program folder |
| `%FLStudioData%` | its `Data` folder |
| `%FLStudioUserData%` | the user data folder, `Documents\Image-Line\FL Studio` |

Samples that come with FL Studio are listed as stock samples. They're left out of packages unless you ask for them, and never offered for deletion. FL Studio also looks for a missing sample next to the project file and in the project's data folder, and Cargo does the same.

Samplers and effects such as Slicex, Fruity Slicer, DirectWave and Fruity Convolver keep their sample paths inside their plugin state. Cargo finds those paths and lists the files. It doesn't rewrite them, because the state is the plugin's own binary data.

## What "used" means

A sample is used when the playlist plays it as an audio clip, or when its channel has notes in a pattern that is on the playlist. Layer channels pass that on to their children, and effects on mixer inserts always count. A project with an empty playlist (pattern mode only) counts every pattern.

## Leftovers

Recordings land in `Audio\Recorded` and renders in `Audio\Rendered` (or the project's data folder), shared by every project. Cargo lists audio files in those folders and in the project's own folder that this project doesn't reference. It then reads every other `.flp` in the project's folder, the folder above it, the `Projects` folder and any folders you add. A file one of them uses is never a leftover.
