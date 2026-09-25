# OpenCode GPT ImageGen

Project-local OpenCode V2 plugin that adds the `gpt_imagegen` raster-image tool. This V2 port is based on [Yuji Hatakeyama's MIT-licensed `opencode-gpt-imagegen`](https://github.com/yuji-hatakeyama/opencode-gpt-imagegen).

## Quick start

1. Open this repository's root directory in OpenCode V2.
2. Connect this machine's OpenAI integration using ChatGPT/Codex OAuth. API-key credentials are not supported.
3. Ask the agent to create an image. The project plugin and the agent skill are discovered from `.opencode/plugins/` and `.opencode/skills/`.

No `npm install` is needed to use the plugin. Each machine needs its own OAuth connection; credentials are not stored in this repository.

## Install into another project

From this repository's root, run:

```bash
node install.mjs /path/to/project
```

The target project directory must already exist. The installer copies only the plugin and skill. Identical files are left unchanged; different existing files cause a safe failure with no writes. Inspect conflicts and get approval before using `--force`; it replaces only the plugin and skill files. The installer does not change global OpenCode configuration.

## Use the tool

The `gpt_imagegen` tool accepts a prompt, an output name, a quality, and optional size and reference images. Example input:

```json
{
  "prompt": "A warm editorial illustration of a small greenhouse at sunrise, centered composition, muted green and amber palette, no text.",
  "out": "greenhouse-sunrise.png",
  "quality": "high",
  "size": "1024x1024"
}
```

`out` is relative to `.opencode/generated-images/`; do not include that directory in the argument. The plugin writes PNG files there, preserves existing files, and chooses a versioned name on collision. Generated images are ignored by Git.

Reference images must be inside the active project and use PNG, JPEG, WebP, or GIF format. Limits: 5 images, 20 MiB per image, 50 MiB total.

For complete agent instructions and argument details, see [the GPT ImageGen skill](.opencode/skills/gpt-imagegen/SKILL.md).

## Test

Node.js 18 or newer is required for the installer and built-in test runner:

```bash
npm test
```

The plugin has no third-party runtime dependencies.

## Compatibility and limitations

- OpenCode V2 only. The package was checked with V2.0.16 on Linux; the original plugin tests also ran under V2.0.15.
- Windows/macOS and future OpenCode versions have not been certified.
- Image requests use `chatgpt.com/backend-api/codex/responses`, an undocumented endpoint that may change independently of this project.
- OpenAI API-key authentication is not supported; connect ChatGPT/Codex OAuth through OpenCode.

See the [OpenCode plugin guide](https://opencode.ai/v2/docs/build/plugins) and [skills guide](https://opencode.ai/v2/docs/skills).

## License and attribution

The plugin source retains the upstream MIT license notice and copyright attribution to Yuji Hatakeyama. Preserve that notice when copying or redistributing the source.
