# blocksmith

A browser-based 3D editor for Minecraft Bedrock builders. Place blocks, design in layers and
groups the way you would in a vector editor, and export a `.mcpack` that imports straight into a
world.

The headline feature is the **mix palette**: define a recipe such as 40% stone bricks / 30%
cobblestone / 20% andesite / 10% mossy cobblestone, and every stroke draws from it at random.
Weathering a road or a wall stops being five passes with five blocks in hand.

A fuller guide in Japanese: **[README.ja.md](README.ja.md)**

## Getting started

```bash
npm install
npm run dev      # http://localhost:5199 (fixed port; startup fails if it is taken)
npm test         # unit tests
npm run build    # typecheck + production build
```

## Bringing a build into a world

1. **Export** in the top bar, then double-click the downloaded `.mcpack` — Minecraft imports it.
2. In the world settings, under behaviour packs, apply the imported pack.

## Upstream data

The block catalogue and the textures come from Mojang's
[bedrock-samples](https://github.com/Mojang/bedrock-samples), which is
`(c) Mojang AB. All rights reserved.` under the Minecraft EULA. **None of it is redistributed
here** — fetch it locally instead:

```bash
npm run fetch-bedrock-snapshot   # the block catalogue source
npm run fetch-textures           # the texture images
```

Without them the editor still runs, falling back to flat colours per block.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | the layers under `src/` and the dependency rules |
| [docs/document-api.md](docs/document-api.md) | the read and write boundaries of `Document` / `World` / `SceneTree` |
| [docs/bedrock-format.md](docs/bedrock-format.md) | the export target: block state meanings, `.mcstructure` ordering, how to verify in game |
| [docs/design-system.md](docs/design-system.md) | the visual language of the interface |
| [CLAUDE.md](CLAUDE.md) | the rules for writing to this repository |

## Licence

[MIT](LICENSE). Minecraft assets are not covered by it — see "Upstream data" above.
