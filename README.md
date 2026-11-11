# Vernacular

Teaching frontier AI assistants the native language of the tools people already use, with a tested record of what works.

**Live prototype:** https://prototypeversions.github.io/Vernacular/

## What is here

| Page | What it does |
|---|---|
| `index.html` | The idea, the method, and the list of records |
| `workbench.html` | A working tool: add two saved files with one setting changed, and it decodes them, separates noise from the real change, and proposes what the change means |
| `records/tone-master-pro.html` | The first record: what Claude can and cannot do with Fender Tone Master Pro presets, with the evidence |

The workbench runs entirely in the browser. It currently recognises plain JSON, Base64 JSON and JSON scrambled with a repeating key of up to 16 bytes.

`examples/` holds two presets exported from a Tone Master Pro, differing only in the Greenbox 8 drive setting.

Fender, Tone Master and Pro Control are trademarks of Fender Musical Instruments Corporation. Vernacular is not affiliated with Fender.
