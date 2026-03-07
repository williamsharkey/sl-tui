# SL-TUI

A terminal-based Second Life client. Connect to Second Life from your terminal or browser with a first-person 3D view, minimap, chat, instant messaging, teleportation, and more.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  TUI Client │────▶│  SL Bridge   │────▶│  Second Life   │
│  (terminal) │     │  (node-      │     │  Grid Servers  │
├─────────────┤     │  metaverse)  │     └────────────────┘
│  Web Client │────▶│              │
│  (browser)  │     └──────────────┘
└─────────────┘
```

- **TUI client** (`tui/`): Full-screen terminal app with ANSI rendering, first-person 3D view, minimap overlay, chat, and keyboard controls
- **Web client** (`client/`): Browser-based client served over WebSocket with the same feature set
- **Server** (`server/`): Express + WebSocket server bridging to SL via vendored [node-metaverse](https://github.com/CasperTech/node-metaverse)
- **Vendor** (`vendor/`): Vendored copy of node-metaverse with ESM fixes

## Features

- **First-person 3D view**: Parallel-ray column renderer with depth fog, terrain coloring, and per-column occlusion
- **Stick figure avatars**: Other avatars render as perspective-scaled ASCII stick figures (head/torso/arms/legs)
- **Minimap overlay**: Top-down map in the upper-right corner showing terrain, objects, avatars, and FOV arc
- **Body-relative movement**: Forward/back/strafe/turn relative to your facing direction
- **Chat**: Local chat, shout, whisper, channel messages, `/me` emotes
- **Instant messaging**: Send and receive IMs
- **Teleportation**: `/tp Region x y z`, accept/decline TP offers, `/tp home`
- **Friends**: Send/accept/decline friend requests, online/offline notifications
- **Flying**: Toggle flight mode
- **Sit/Stand/Touch**: Interact with in-world objects
- **Profile viewing**: Look up avatar profiles
- **People search**: Find other users
- **Login screen**: Interactive login with credential saving
- **Delta rendering**: Only changed cells are updated each frame for efficiency

## Quick Start

```bash
npm install
```

### TUI Client (Terminal)

```bash
# Interactive login
npm run tui

# Auto-login via CLI args
npm run tui -- -u "FirstName LastName" -p "password"

# Auto-login via environment variables
SL_USERNAME="FirstName LastName" SL_PASSWORD="password" npm run tui

# Black & white mode (no colors)
npm run tui -- --bw
```

### Web Client (Browser)

```bash
npm run dev        # Start server on port 3000
open http://localhost:3000
```

### Development

```bash
npm run dev        # Start with hot reload (tsx --watch)
npm run build      # TypeScript compile
npm run start      # Run compiled JS
npm run test:tui   # Run TUI unit + integration tests (91 tests)
```

## Keyboard Controls

| Key | Action |
|-----|--------|
| `W` / `↑` | Move forward |
| `S` / `↓` | Move backward |
| `A` | Strafe left |
| `D` | Strafe right |
| `←` | Turn left |
| `→` | Turn right |
| `Space` | Jump / fly up |
| `F` | Toggle flying |
| `Enter` | Open chat |
| `Escape` | Close chat |
| `Q` | Quit |

## Chat Commands

| Command | Description |
|---------|-------------|
| `/tp Region x y z` | Teleport to region at coordinates |
| `/im uuid message` | Send instant message |
| `/shout message` | Shout (100m range) |
| `/whisper message` | Whisper (10m range) |
| `/me action` | Emote |
| `/42 message` | Chat on channel 42 |
| `/logout` | Log out and return to login screen |

## Project Structure

```
server/
  main.ts          Express + WebSocket server
  session.ts       Per-user session (web client)
  sl-bridge.ts     SL protocol bridge (node-metaverse wrapper)
  grid-state.ts    3D-to-2D projection, FP renderer, frame diffing
tui/
  main.ts          CLI entry point
  app.ts           TUI application (tick loop, state management)
  renderer.ts      ANSI escape sequence rendering
  screen.ts        Terminal layout calculator
  input.ts         Keyboard input handler
  chat-buffer.ts   Chat message ring buffer
  login-screen.ts  Login screen renderer
  credentials.ts   Credential persistence (~/.sl-tui-credentials)
  types.ts         Shared interfaces (ISLBridge, WritableTarget)
client/
  index.html       Single-file browser client
test/
  tui-unit.ts      52 unit tests (layout, rendering, input, grid projection)
  tui-integration.ts  39 integration tests (app lifecycle, chat, movement)
vendor/
  node-metaverse/  Vendored SL protocol library with ESM patches
```

## Requirements

- Node.js 18+
- A Second Life account

## License

MIT
