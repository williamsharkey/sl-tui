# SL-TUI

A terminal-based Second Life client. Connect to Second Life from your terminal with a first-person 3D view, minimap, chat, instant messaging, and more.

Requires Node.js 18+ and a font with Unicode sextant support (Iosevka, JetBrains Mono Nerd Font, or any Nerd Font variant).

## Quick Start

```bash
npm install
npm run dev        # Start with hot reload
npm start          # Run directly

# Or via npx (after npm link)
npx sl-tui
```

## Features

- **First-person 3D view**: Comanche-style voxel raycaster with bilinear terrain interpolation, slope shading, depth fog, and region sky colors
- **Sextant rendering**: 2x3 Unicode block characters (U+1FB00) for high-resolution terminal graphics
- **Avatar rendering**: Detailed humanoid silhouettes with skin/clothing zones and directional shading, plus CPU triangle rasterizer for mesh avatars
- **Minimap overlay**: Top-down map showing terrain, objects, avatars, and FOV arc
- **Body-relative movement**: Forward/back/strafe/turn with client-side dead reckoning for smooth motion
- **Chat**: Local chat, shout, whisper, channel messages, emotes
- **Instant messaging**: Send/receive IMs with conversation tracking and unread counts
- **Menu system**: Lotus 1-2-3 style hierarchical menu for friends, messages, teleport, actions
- **Teleportation**: `/tp Region x y z`, accept/decline TP offers, `/tp home`
- **Friends**: Friend requests, online/offline notifications, fly-to-avatar
- **Flying**: Toggle flight mode with altitude control
- **Object interaction**: Sit, stand, touch, inspect
- **Profile viewing**: Look up avatar profiles
- **Login**: Interactive login with credential saving
- **Delta rendering**: Only changed cells update each frame
- **Resize handling**: Debounced full redraw on terminal resize
- **Sky gradient**: Reads region EEP/WindLight environment for sky colors and fog

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
  grid-state.ts    Voxel raycaster, minimap projection, frame diffing
  pixel-to-cells.ts  2x3 sextant pixel-to-cell conversion
  soft-rasterizer.ts CPU triangle rasterizer with depth buffer
  avatar-cache.ts  Avatar mesh fetching/caching
test/
  tui-unit.ts      73 unit tests
  tui-integration.ts  39 integration tests
  bench.ts         Performance benchmark
vendor/
  node-metaverse/  Vendored SL protocol library (ESM-patched)
bin/
  sl-tui.js        npx entry point
```

## Testing

```bash
npm test           # Run all 112 tests
npm run bench      # Performance benchmark (requires SL credentials)
```

## Requirements

- Node.js 18+
- A Second Life account
- Terminal font with sextant character support (Iosevka, any Nerd Font)

## License

MIT
