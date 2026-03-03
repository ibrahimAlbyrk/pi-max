# Image Generation Extension

Generate and edit images using Google's Gemini image models (Nano Banana) directly from pi.

## Setup

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Set the environment variable:
   ```bash
   export GEMINI_API_KEY="your-api-key"
   ```
3. Install dependencies:
   ```bash
   cd .pi/extensions/image-generation && npm install
   ```
4. Reload pi (`/reload`) or restart

## Models

| Model | ID | Speed | Quality | Cost (1K) | Max Resolution |
|-------|-----|-------|---------|-----------|----------------|
| **Nano Banana 2** (default) | `gemini-3.1-flash-image-preview` | Fast | High | ~$0.067 | 4K |
| **Nano Banana Pro** | `gemini-3-pro-image-preview` | Slower | Highest | ~$0.134 | 4K |
| **Nano Banana v1** | `gemini-2.5-flash-image` | Fastest | Good | ~$0.039 | 1K |

## Tools

### `generate_image`

Generate an image from a text prompt.

**Parameters:**
- `prompt` (required) — Image description
- `output_path` (optional) — File path to save (e.g., `assets/hero.png`)
- `model` (optional) — Model to use (default: `gemini-3.1-flash-image-preview`)
- `aspect_ratio` (optional) — `1:1`, `16:9`, `9:16`, `3:2`, `4:3`, etc.
- `size` (optional) — `512px`, `1K`, `2K`, `4K` (default: `1K`)

**Examples:**
```
"Generate a pixel art fireball sprite and save to assets/fireball.png"
"Create a 16:9 wallpaper of a cyberpunk city at 4K resolution"
"Generate 5 different enemy sprites in pixel art style for my game"
```

### `edit_image`

Edit an existing image using a text prompt.

**Parameters:**
- `prompt` (required) — Edit instruction
- `image_path` (required) — Source image to edit
- `output_path` (optional) — Save location (defaults to overwriting source)
- `reference_images` (optional) — Additional reference images (up to 14 total)
- `model` (optional) — Model to use
- `aspect_ratio` (optional) — Output aspect ratio
- `size` (optional) — Output resolution

**Examples:**
```
"Remove the background from assets/logo.png"
"Make this image pixel art style"
"Add a sunset sky to this landscape photo"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | **Required.** Google AI API key |
| `PI_IMAGE_MODEL` | Default model override |

## Use Cases

### Game Development
- Sprite generation (characters, items, enemies)
- Tile sets and backgrounds
- UI elements and icons
- Logo and branding assets

### Web Development
- Hero images and banners
- Placeholder images
- Social media assets
- Favicon and app icons

### Prototyping
- UI mockups and wireframes
- Concept art
- Marketing materials
