# Overworld tiles

The Game Mode overworld's and towns' built-in tile packs, one per setting family, in the shared
tile-pack format (`packages/shared/src/features/world/tile-pack.ts`): a palette, and every tile's
variants as sixteen rows of sixteen characters. They are Marinara Engine's own base set, drawn in code by
`scripts/art/build-overworld-tiles.mjs` (`pnpm art:overworld`): change the art there and rerun it, never
by editing these files. The Engine serves them at `/api/game-tile-packs/builtin/<family>`; packs made in
Pixelforge or imported from a file are stored beside them in the tile-pack library. A tile a pack lacks
is drawn plain.
