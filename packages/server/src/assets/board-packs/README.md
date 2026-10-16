# Built-in board packs

The Engine's own art for fight boards (Capability API 1.333): `<environment>.json` for each tactical
environment (forest, dungeon, ...) and `props.json` for the shared prop library, each a board pack
(`boardPackVersion: 1`, see `packages/shared/src/features/world/board-pack.ts`). A board that names no
pack, with no library pack for its environment, is drawn with the file here; with none, as today.
Art lands here only once it is approved.

`icons.json` and `portraits.json` (Capability API 1.338) are the game's icons and portraits, packs of
kind `icons` (`ic_` tiles: `ic_cond_<id>`, `ic_item_<id>`, `ic_<catalog>_<entry>`, or what a ruleset's
`icon` names) and `portraits` (`pt_<name>`, a pixel bust two cells by two at 48 px cells, its expressions
as `pt_<name>@happy` and so on). A library pack of that kind comes first; anything neither has is drawn
as today.
