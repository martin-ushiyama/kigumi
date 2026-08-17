# Bedrock-side format notes

Notes on the target platform (Minecraft Bedrock Edition) — specifically the parts **our
implementation depends on and that took real effort to research**.

## Why this file exists

We once implemented the stair orientation (`weirdo_direction`) by guesswork, left it
"unverified", and did not notice the mismatch until it showed up in-game
. And **it was findable** —
community references have the mapping table.

Testing in-game is the last step of verification, not the first. **Research first.** Only
measure in-game when research turns up nothing, and record the result here.

### Research order

**Do not skip step 1.** A local snapshot of Mojang's official data is faster and more
reliable than searching the web. The snapshot is **not committed** — a clean clone fetches
it once with `npm run fetch-bedrock-snapshot`. Only `data/bedrock/SOURCE.json` (the pinned
upstream commit + file hashes) is in the repository; everything else under `data/bedrock/`
is gitignored.

1. **`data/bedrock/mojang-blocks.json`** (local snapshot of Mojang's official bedrock-samples, obtained via `npm run fetch-bedrock-snapshot`)
   — **which block has which states** is fully answered here. Readable via `scripts/bedrock-snapshot.mjs`

   ```bash
   node -e "const d=require('./data/bedrock/mojang-blocks.json');      console.log(d.data_items.find(i=>i.name==='minecraft:oak_stairs').properties)"
   ```

2. **Microsoft Learn** ([Intrinsic Block States List](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/blockreference/examples/intrinsicblockstateslist)) — the **type and value range** of each state is here. However,
   **the "which blocks have it" listing can be stale** (see the `vertical_half` example below).
   The meaning of numeric values (is 0 east or north?) is not documented either
3. **Community references** (Minecraft Wiki / forums) — the meaning of numeric values is often found here. **Check that multiple sources agree**
4. **In-game measurement** — when the above yields nothing, or to double-check

#### Example: `vertical_half` vs `top_slot_bit`

In the Microsoft Learn list, `top_slot_bit` (Boolean) enumerates **a large number of stone/wooden
slabs** as its blocks, while the blocks for `minecraft:vertical_half` are **TBD (not listed)**.
Read alone, this makes blocksmith's implementation look wrong.

Querying the official snapshot showed the opposite:

```
minecraft:normal_stone_slab → ['minecraft:vertical_half']
minecraft:cobblestone_slab  → ['minecraft:vertical_half']
```

`top_slot_bit` belongs to the **legacy id family** (`minecraft:stone_slab` + `stone_slab_type`);
the new ids used by our catalog use `vertical_half`. **The primary data is what's correct.**

## Stairs

### `weirdo_direction` (0-3)

The direction the **tall face (the wall you face when climbing)** points.

| Value | Direction | blocksmith coordinates |
|---|---|---|
| 0 | East | +X |
| 1 | West | -X |
| 2 | South | +Z |
| 3 | North | -Z |

**A label, not a rotation amount.** 0 and 1 are 180 degrees apart, so "+1 = rotate 90 degrees"
does not hold. To rotate, convert to a direction vector, rotate, then convert back
(`orientation.ts::rotateWeirdoDirection`).

Backing: in-game measurement (2026-08-01, Bedrock 1.21) + community references (data values 0-3
are east/west/south/north; +8 flips upside down). Both agree.

### `upside_down_bit`

`true` makes the stair upside down. The direction does not change.

The community note "+8 on the data value flips it" describes the legacy data-value scheme; in
current block states it is an independent boolean.

## States held by catalog blocks

Actual values pulled from `data/bedrock/mojang-blocks.json`.

| Shape | States |
|---|---|
| Stairs | `upside_down_bit` (Boolean) / `weirdo_direction` (Integer 0-3) |
| Slab | `minecraft:vertical_half` (String: `bottom` / `top`) |
| Pillar (log / basalt etc.) | `pillar_axis` (String: `x` / `y` / `z`) |
| Everything else | None |

For all 237 catalog entries, we verified that **every state blocksmith writes exists in the
official data** (0 mismatches).

```bash
npm run check-block-states
```

The upstream snapshot is not committed to the repository for EULA reasons, so **in environments
without it the check skips and exits successfully**. No CI workflow fetches the snapshot, so in
practice the check only takes effect in environments that have run
`npm run fetch-bedrock-snapshot`.

A wrong state name is silently ignored in-game — you can't notice until you place the block.
This check mechanically closes that hole (**the meaning of values** — whether 0 in
`weirdo_direction` is east or north — it cannot know; that lives in the measured table above).

## Coordinate system

| Axis | Direction |
|---|---|
| +X | East |
| -X | West |
| +Z | South |
| -Z | North |
| +Y | Up |

`/structure load` **places the structure fixed to the world's absolute coordinates** (unless a
rotation is specified). The player's facing has no effect — when you want to confirm compass
directions, embed a marker inside the structure so the person placing it doesn't have to judge
direction themselves (`scripts/gen-stairs-probe.mjs` takes this form).

## `.mcstructure` / `.mcpack`

### block_indices ordering

The 1-D array is folded in `x → y → z` order: `index = x * (sy * sz) + y * sz + z`.

There are two layers; the second is for waterlogged blocks (blocksmith writes all `-1` = empty).

### A pack has two different names

| Where | What appears | Example |
|---|---|---|
| Minecraft's import screen / pack list | `manifest.header.name` | `blocksmith - test (bs:test)` |
| The name typed into `/structure load` | derived from the `structures/{ns}/{name}.mcstructure` path | `bs:test` |

**They do not match.** Typing the display name shown on the import screen does not work
 — which is why `buildMcpack`
now embeds the loadable form in parentheses inside the display name.

### Steps to install a pack

1. Double-click the `.mcpack` to import it
2. World settings → Behavior packs → **move it from "My packs" to "Active"** (forget this and the structure won't be found)
3. `/structure load bs:{name} ~ ~ ~`

Rotation and mirroring can also be specified: `/structure load bs:{name} ~ ~ ~ 90_degrees none`
(rotation `0_degrees` / `90_degrees` / `180_degrees` / `270_degrees`, mirror `none` / `x` / `z` / `xz`)

Cheats must be enabled. `/structure` has no `list` subcommand; to see what exists, use the
autocomplete suggestions while typing the command.

## When verifying in-game

There are two scripts under `scripts/`. **Their roles differ** — use the right one.

| Script | What it verifies | How the NBT is built |
|---|---|---|
| `gen-stairs-probe.mjs` | The Bedrock spec itself (value ↔ direction mapping) | Hand-assembled; bypasses blocksmith's conversion |
| `gen-stairs-verify.mjs` | Whether blocksmith's output matches the spec | **The app's export functions** (`buildMcstructure` → `buildMcpack`), fed through the same `WorldReader` interface |

If verify were hand-assembled, it would bypass catalog matching and state merging, missing the
case where "verification passes but the actual export is off".

For context, the app's export pipeline: the editing model's source of truth is the
`Document`-owned `EditorScene` (scene tree + owner-local cells), and export reads the derived
world-coordinate read-model `WorldIndex` (`doc.world`, a `WorldReader`), which
`ProjectService.exportMcpack` (`src/services/project.ts`) runs through
`buildMcstructure` (`src/export/mcstructure.ts`) → `buildMcpack` (`src/export/mcpack.ts`).
`VoxelWorld` was removed from the app runtime and survives only as plain `WorldReader` storage
for scripts and tests — the verify script fills one via `packCell` + `encodeOrientation` and
feeds it through the same two export functions, so catalog matching, state merging, and palette
construction are all exercised.

Both accept a name argument. **Reusing a name forces you to delete the old pack in Minecraft
before importing again**, so use a fresh name each time you rebuild.

```bash
npx vite-node scripts/gen-stairs-probe.mjs stairs_a
npx vite-node scripts/gen-stairs-verify.mjs stairs_b
```
