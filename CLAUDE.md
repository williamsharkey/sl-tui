# SL-TUI Development Guide

## Quick Start
```bash
npm install
npm run dev          # Run TUI with hot reload
npm test             # Run all tests (112 tests)
npm run bench        # Performance benchmark (requires SL credentials)
```

## Architecture
Pure TypeScript TUI — no C compilation, no native deps. Node.js 18+.

- `tui/` — Terminal client (app state machine, ANSI renderer, input, menu)
- `server/` — SL protocol bridge, voxel raycaster, soft rasterizer, pixel-to-cells
- `vendor/node-metaverse/` — Vendored SL protocol library (ESM-patched)
- `test/` — Unit tests (73) + integration tests (39)
- `bin/sl-tui.js` — npx entry point

## Key Files
| File | Purpose |
|------|---------|
| `tui/app.ts` | State machine, tick loop (15Hz), mode dispatch |
| `tui/renderer.ts` | ANSI escape output, truecolor, delta rendering |
| `tui/screen.ts` | Layout calculator (FP view, minimap, chat, status) |
| `tui/menu.ts` | Lotus 1-2-3 style hierarchical menu (friends/IM/teleport) |
| `tui/input.ts` | Raw stdin keypress handler, mode-based dispatch |
| `server/grid-state.ts` | Voxel raycaster (Comanche-style), minimap projection, frame diffing |
| `server/pixel-to-cells.ts` | 2x3 sextant pixel-to-cell conversion (U+1FB00 block) |
| `server/soft-rasterizer.ts` | CPU triangle rasterizer with depth buffer + face shading |
| `server/sl-bridge.ts` | SL protocol wrapper (login, movement, chat, position interpolation) |
| `server/avatar-cache.ts` | Avatar mesh fetching/caching |

## Rendering Pipeline
1. Voxel raycaster → pixel buffer (2x cols, 3x rows) with depth + OID
2. Bilinear terrain interpolation + slope shading + fog
3. Avatar/object projection onto pixel buffer
4. `pixelsToCells()` — 2x3 sextant quantization (64 patterns, 2-color per cell)
5. Frame diff → delta ANSI output

## Conventions
- Terrain: 256x256 grid, 1m per cell, bilinear interpolated
- Sky: gradient from region EEP/WindLight settings (zenith → horizon)
- Colors: hex strings (`'#rrggbb'`) in Cell, RGB tuples in pixel buffers
- Position: client-side dead reckoning + exponential server correction
- Movement: control flags sent once per direction change (not per key repeat)

## Testing
```bash
npx tsx test/tui-unit.ts          # 73 unit tests
npx tsx test/tui-integration.ts   # 39 integration tests
```
Tests use mock bridges — no SL connection needed.

## node-metaverse Vendor Fixes
- `classes/Logger.ts`: `import winston from 'winston'`
- `classes/llsd/LLSD.ts`: default import + destructure
- `LoginHandler.ts`: ESM `__dirname` shim
- `classes/InventoryFolder.ts`: ESM `__dirname` shim
