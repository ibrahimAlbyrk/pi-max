# Image Generation Extension

Generate and edit images using multiple AI providers directly from pi.

## Setup

Set at least one API key:

```bash
export GEMINI_API_KEY="..."       # Google Gemini (Nano Banana)
export OPENAI_API_KEY="..."       # OpenAI gpt-image-1
export FAL_KEY="..."              # FLUX Pro via fal.ai
export STABILITY_API_KEY="..."    # Stability AI (SD3)
```

Install dependencies and reload:

```bash
cd .pi/extensions/image-generation && npm install
```

Then `/reload` in pi.

## Providers

| Provider | Key | Model | Speed | Quality | Edit Support |
|----------|-----|-------|-------|---------|--------------|
| **gemini** | `GEMINI_API_KEY` | Nano Banana 2 | Fast | High | Yes (14 refs) |
| **openai** | `OPENAI_API_KEY` | gpt-image-1 | Medium | Highest | Yes |
| **flux** | `FAL_KEY` | FLUX Pro v1.1 | Fast | High | Yes (img2img) |
| **stability** | `STABILITY_API_KEY` | SD3.5 Large | Medium | High | Yes (search-replace) |

Provider is auto-detected from available keys (priority: gemini > openai > flux > stability).
Override with `PI_IMAGE_PROVIDER` env var or `provider` tool parameter.

## Tools

### `generate_image`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | Yes | Image description |
| `output_path` | No | Save path (e.g., `assets/hero.png`) |
| `provider` | No | `gemini`, `openai`, `flux`, `stability` |
| `aspect_ratio` | No | `1:1`, `16:9`, `9:16`, `3:2`, `4:3`, etc. |
| `size` | No | `512px`, `1K`, `2K`, `4K` (Gemini only) |

### `edit_image`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | Yes | Edit instruction |
| `image_path` | Yes | Source image to edit |
| `output_path` | No | Save path (defaults to overwriting source) |
| `reference_images` | No | Reference image paths (max 14, Gemini) |
| `provider` | No | Provider to use |
| `aspect_ratio` | No | Output aspect ratio |
| `size` | No | Output resolution |

## Examples

```
"Generate a pixel art fireball sprite and save to assets/fireball.png"
"Create a 16:9 wallpaper of a cyberpunk city using openai"
"Edit assets/logo.png to remove the background"
"Generate 5 enemy sprites in pixel art style with flux provider"
```

## Budget

Track and limit image generation spending with a JSON config file.

**Global config** (all projects): `~/.pi/agent/extensions/image-generation.json`
**Project config** (overrides global): `<project>/.pi/extensions/image-generation.json`

```json
{
  "budgetLimit": 20,
  "budgetWarning": 15
}
```

| Field | Description |
|-------|-------------|
| `budgetLimit` | Max spend in $. Generation blocked when reached. |
| `budgetWarning` | Warning threshold in $. Shows alert on each generation after this. |

Both fields are optional. Without `budgetLimit`, there is no spending cap.

Budget state is tracked per session via `appendEntry` and persists across reloads.

### Approximate costs per image

| Provider | $/image |
|----------|---------|
| gemini | $0.045–$0.151 (varies by size) |
| openai | $0.080 |
| flux | $0.050 |
| stability | $0.065 |

## Architecture

```
src/
├── index.ts           — Tool registration (provider-agnostic)
├── types.ts           — ImageProvider interface
├── resolver.ts        — Auto-detect or select provider
├── budget.ts          — Budget tracking and limits
├── utils.ts           — Shared utilities
└── providers/
    ├── gemini.ts      — Google Gemini (Nano Banana)
    ├── openai.ts      — OpenAI gpt-image-1
    ├── flux.ts        — FLUX Pro via fal.ai
    └── stability.ts   — Stability AI SD3
```

Adding a new provider: implement `ImageProvider` interface in `providers/`, register in `resolver.ts`.
