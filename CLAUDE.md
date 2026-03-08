# SL-TUI Development Guide

## Quick Start
```bash
npm install
npm run dev          # Run TUI with hot reload
npm test             # Run all tests (120 tests)
npm run bench        # Performance benchmark (requires SL credentials)
```

## Architecture
Pure TypeScript TUI — no C compilation, no native deps. Node.js 18+.

- `tui/` — Terminal client (app state machine, ANSI renderer, input, menu)
- `server/` — SL protocol bridge, voxel raycaster, soft rasterizer, pixel-to-cells
- `vendor/node-metaverse/` — Vendored SL protocol library (ESM-patched)
- `test/` — Unit tests (81) + integration tests (39)
- `bin/sl-tui.js` — npx entry point

## Key Files
| File | Purpose |
|------|---------|
| `tui/app.ts` | State machine, tick loop (15Hz), mode dispatch |
| `tui/renderer.ts` | ANSI escape output, truecolor, delta rendering |
| `tui/screen.ts` | Layout calculator (FP view, minimap, chat, status) |
| `tui/menu.ts` | Lotus 1-2-3 style hierarchical menu (friends/IM/teleport) |
| `tui/input.ts` | Raw stdin keypress handler, mode-based dispatch |
| `server/grid-state.ts` | Voxel raycaster (Comanche-style), triangle rasterizer, minimap, frame diffing |
| `server/pixel-to-cells.ts` | 2x3 sextant pixel-to-cell conversion (U+1FB00 block) |
| `server/soft-rasterizer.ts` | CPU triangle rasterizer with depth buffer + face shading + OID tracking |
| `server/sl-bridge.ts` | SL protocol wrapper (login, movement, chat, position interpolation, linkset flattening) |
| `server/quat-utils.ts` | Quaternion rotation/multiplication for child prim transforms |
| `server/avatar-cache.ts` | Avatar mesh fetching/caching |

## Rendering Pipeline
1. Voxel raycaster or triangle mesh → pixel buffer (2x cols, 3x rows) with depth + OID
2. Bilinear terrain interpolation + slope shading + fog
3. Near objects rasterized as 3D primitives into full-size render target (shared depth buffer)
4. Child prims (linksets) flattened with quaternion transform composition
5. NDC depth linearized to world distance when mixing raster objects with voxel terrain
6. `pixelsToCells()` — 2x3 sextant quantization (64 patterns, 2-color per cell)
7. Frame diff → delta ANSI output

## Primitive Types
10 SL primitive shapes supported via `getUnitGeometry(pathCurve, profileCurve)`:
- **Linear path** (16): box, cylinder, prism, wedge, cone
- **Circular path** (32/48): sphere, torus, tube, ring
- ProfileCurve low nibble = shape, high nibble = hole type (masked out)

## Conventions
- Terrain: 256x256 grid, 1m per cell, bilinear interpolated
- Sky: gradient from region EEP/WindLight settings (zenith → horizon)
- Colors: hex strings (`'#rrggbb'`) in Cell, RGB tuples in pixel buffers
- Position: client-side dead reckoning + exponential server correction
- Movement: control flags sent once per direction change (not per key repeat)
- Linksets: flat hierarchy (root + children), child positions/rotations are local to parent

## Testing
```bash
npx tsx test/tui-unit.ts          # 81 unit tests
npx tsx test/tui-integration.ts   # 39 integration tests
```
Tests use mock bridges — no SL connection needed.

## node-metaverse Vendor Fixes
- `classes/Logger.ts`: `import winston from 'winston'`
- `classes/llsd/LLSD.ts`: default import + destructure
- `LoginHandler.ts`: ESM `__dirname` shim
- `classes/InventoryFolder.ts`: ESM `__dirname` shim
