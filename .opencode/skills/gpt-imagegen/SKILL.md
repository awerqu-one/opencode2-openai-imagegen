---
name: gpt-imagegen
description: Generate raster images with the project's gpt_imagegen tool and install it into another OpenCode V2 project. Use when the user asks to create illustrations, photos, textures, sprites, mockups, image variations, or to install/copy this tool. Do not use for SVG/vector edits, maintaining an existing logo or icon system, or assets better built in HTML/CSS/canvas.
---

# GPT ImageGen

Use `gpt_imagegen` when the user asks to create a raster image. The tool returns a PNG saved inside the active project.

## Requirements

- Open this repository as an OpenCode V2 project so `.opencode/plugins/gpt-imagegen.js` loads.
- Connect this machine's OpenAI integration with ChatGPT/Codex OAuth. API-key credentials are not supported; never copy credentials into the repository or prompt.
- Allow network access to `chatgpt.com` for image generation.
- The plugin calls the undocumented `chatgpt.com/backend-api/codex/responses` endpoint. It may change independently of this project.

## Install in another project

Ask for the target project path if it was not provided. From this repository's root, run:

```bash
node install.mjs /path/to/project
```

The target directory must already exist. The installer copies only the plugin and skill to their project-local `.opencode` paths; it does not change global OpenCode configuration. Identical files are left alone. If different files already exist, the installer stops without writing anything. Inspect the conflict and get explicit user approval before using `--force`; that flag replaces only the managed plugin and skill files. Symlinked destination paths are rejected.

No `npm install` is required to run the plugin.

## Generate

Call the `gpt_imagegen` tool with:

- `prompt` — describe subject, composition, style, lighting, and important constraints.
- `out` — a relative filename under `.opencode/generated-images/`; use `hero.png`, not `.opencode/generated-images/hero.png`.
- `quality` — `low`, `medium`, `high`, or `auto`.
- `size` — optional `WIDTHxHEIGHT`; dimensions must be multiples of 16, max edge 3840, aspect ratio at most 3:1, and total pixels between 655,360 and 8,294,400.
- `images` — optional project-relative reference image paths. Only PNG, JPEG, WebP, and GIF files inside the active project are accepted; maximum 5 images, 20 MiB each, 50 MiB total.

Example:

```json
{
  "prompt": "A warm editorial illustration of a small greenhouse at sunrise, centered composition, muted green and amber palette, no text.",
  "out": "greenhouse-sunrise.png",
  "quality": "high",
  "size": "1024x1024"
}
```

Do not overwrite an existing asset manually: the plugin preserves existing files and chooses a versioned filename. On success, report the exact returned path. If the tool fails, report the failure rather than claiming an image was created.

## Limits

- References and output stay within the active project; do not work around this boundary with absolute paths or symlinks.
- Output is PNG under `.opencode/generated-images/`.
- The plugin is V2-only. Compatibility beyond the versions verified by this repository is not guaranteed.
- Upstream MIT license and attribution to Yuji Hatakeyama are retained in the plugin source.
