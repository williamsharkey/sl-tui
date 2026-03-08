# SL-TUI

A terminal-based Second Life client. Connect to Second Life from your terminal with a first-person 3D view, minimap, chat, instant messaging, and more.

![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![License MIT](https://img.shields.io/badge/license-MIT-blue)

## Install

```bash
npx sl-tui
```

Or install globally:

```bash
npm install -g sl-tui
sl-tui
```

Requires Node.js 18+ and a terminal font with Unicode sextant support (Iosevka, JetBrains Mono, or any Nerd Font variant).

## Features

- **First-person 3D view** — Comanche-style voxel raycaster + triangle rasterizer (toggle with `R`), bilinear terrain, slope shading, depth fog, region sky colors
- **Structure rendering** — Full linkset support: buildings, houses, and multi-prim objects render as detailed structures you can walk inside
- **10 primitive types** — Box, cylinder, sphere, cone, wedge, prism, torus, tube, ring, hemisphere
- **Sextant rendering** — 2x3 Unicode block characters (U+1FB00) for high-resolution terminal graphics
- **Avatar rendering** — Detailed humanoid silhouettes with walking animation, plus CPU triangle rasterizer for mesh avatars
- **Minimap overlay** — Top-down map showing terrain, objects, avatars, and FOV arc
- **Movement** — Forward/back/strafe/turn with client-side dead reckoning and smooth camera animation
- **Chat** — Local chat, shout, whisper, channel messages, emotes
- **Instant messaging** — Send/receive IMs with conversation tracking and unread counts
- **Menu system** — Lotus 1-2-3 style hierarchical menu for friends, messages, teleport, actions
- **Teleportation** — `/tp Region x y z`, accept/decline TP offers, `/tp home`
- **Friends** — Friend requests, online/offline notifications, fly-to-avatar
- **Flying** — Toggle flight mode with altitude control
- **Object interaction** — Sit, stand, touch, inspect
- **Login** — Interactive login with credential saving
- **Delta rendering** — Only changed cells update each frame for minimal flicker
- **Sky gradient** — Reads region EEP/WindLight environment for sky colors and fog

## Keyboard Controls

| Key | Action |
|-----|--------|
| `W` / `Up` | Move forward |
| `S` / `Down` | Move backward |
| `A` | Strafe left |
| `D` | Strafe right |
| `Left` | Turn left |
| `Right` | Turn right |
| `Space` | Jump / fly up |
| `F` | Toggle flying |
| `R` | Toggle render mode (voxel/triangle) |
| `V` | Toggle dither (wind effect) |
| `Enter` | Open chat |
| `Escape` | Close chat |
| `/` or `Tab` | Open menu |
| `Q` | Quit |

## Chat Commands

| Command | Description |
|---------|-------------|
| `/tp Region x y z` | Teleport to region |
| `/im uuid message` | Send instant message |
| `/shout message` | Shout (100m range) |
| `/whisper message` | Whisper (10m range) |
| `/me action` | Emote |
| `/42 message` | Chat on channel 42 |
| `/logout` | Return to login screen |

## Development

```bash
git clone https://github.com/williamsharkey/sl-tui.git
cd sl-tui
npm install
npm run dev        # Start with hot reload
npm test           # Run all 120 tests
npm run bench      # Performance benchmark (requires SL credentials)
```

## Project Structure

```
tui/
  app.ts           State machine, 15Hz tick loop
  renderer.ts      ANSI escape rendering (truecolor + 256-color + BW)
  screen.ts        Terminal layout calculator
  input.ts         Raw stdin keypress handler
  menu.ts          Hierarchical menu (friends/IM/teleport/actions)
  login-screen.ts  Login form renderer
  chat-buffer.ts   Chat message ring buffer
  credentials.ts   Credential persistence (~/.sl-tui-credentials)
server/
  sl-bridge.ts     SL protocol bridge with position interpolation
  grid-state.ts    Voxel raycaster, triangle rasterizer, minimap, frame diffing
  pixel-to-cells.ts  2x3 sextant pixel-to-cell conversion
  soft-rasterizer.ts CPU triangle rasterizer with depth buffer + face shading
  quat-utils.ts    Quaternion math for linkset child prim transforms
  avatar-cache.ts  Avatar mesh fetching/caching
test/
  tui-unit.ts      81 unit tests
  tui-integration.ts  39 integration tests
  bench.ts         Performance benchmark
vendor/
  node-metaverse/  Vendored SL protocol library (ESM-patched)
bin/
  sl-tui.js        npx entry point
```

## Rendering Pipeline

1. Voxel raycaster or triangle mesh → pixel buffer (2x cols, 3x rows) with depth + object ID
2. Bilinear terrain interpolation + slope shading + fog
3. Near objects rasterized as 3D primitives (box, sphere, cylinder, torus, etc.) into full-size render target
4. Child prims (linksets) flattened with quaternion transform composition
5. NDC depth linearized to world distance for voxel/raster depth buffer compatibility
6. Avatar mesh rasterization or humanoid pixel silhouettes with walking animation
7. `pixelsToCells()` — 2x3 sextant quantization (64 patterns, 2-color per cell)
8. Frame diff → delta ANSI output

## Requirements

- Node.js 18+
- A Second Life account
- Terminal font with sextant character support (Iosevka, any Nerd Font)

## License

MIT
