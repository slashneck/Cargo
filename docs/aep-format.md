# How Cargo reads .aep files

An After Effects project is a big-endian RIFF container (`RIFX`, form type `Egg!`) followed by an XMP metadata packet. Every chunk is `id (4 bytes) · size (u32) · data`, padded to an even length. A `LIST` chunk's data starts with a 4-byte list type followed by more chunks.

Cargo keeps the byte range of every chunk. A tree that wasn't edited serializes back to the identical file, and only edited chunks (and the sizes of their parent lists) are rebuilt. Lists that don't parse cleanly (for example `btdk` text data) are kept as opaque bytes. Before a relinked project is written, it's re-parsed and compared item by item.

## Project items

```
LIST Fold                         the project panel
  LIST Item                       one per item
    idta   u16 @0   type: 1 folder, 4 composition, 7 footage
           u32 @16  item id
    Utf8            name (empty for file footage; AE shows the file name)
    LIST Sfdr       folder contents (more LIST Item)
    cdta            composition settings:
                      fps       = u32 @8 / u32 @4
                      duration  = u32 @44 / u32 @48 seconds
                      width u16 @140, height u16 @142
    LIST Layr       one per layer
      ldta   u32 @40  id of the layer's source item (0 for text, shape, camera, light)
      Utf8            layer name (empty = source name)
      LIST tdgp       properties; effects sit under tdmn "ADBE Effect Parade"
                      as pairs of (tdmn match name, LIST sspc)
    LIST Pin        footage source
      sspc   fourcc @22 file type, u16 @32 width, u16 @36 height,
             duration = u32 @38 / u32 @42 seconds (0 for stills)
      opti   "Soli" @0 for solids (RGB floats @14, name @26)
      LIST Als2
        alas          JSON: {"fullpath":"D:\\...\\clip.mov","target_is_folder":false}
LIST EfdG                         effects used in the project (tdmn match name + fnam display name)
```

The XMP packet after the RIFX data names the AE version that saved the file (`xmp:CreatorTool`).

## .aepx

The XML flavour mirrors the same tree. Each chunk becomes an element named after its id. Leaf data is hex in `bdata`, `Utf8` becomes `<string>`, and `alas` becomes `<fileReference fullpath="…">`. Cargo converts it into the same chunk tree and runs the same code on it.

## What "used" means

A footage item is used when at least one layer in any composition has it as its source. Files named in `footage("…")` expressions also count as used. Image sequences are detected from numbered siblings of the referenced frame when the footage has a duration.

If you find a project Cargo reads wrongly, please open an issue with the After Effects version. A small sample project helps most.
