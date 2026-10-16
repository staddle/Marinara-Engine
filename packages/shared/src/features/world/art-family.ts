// ──────────────────────────────────────────────
// A setting's art and music (worldgen W6f): the family a kit's art and music live in, and which of a
// game's assets belong to a family. Folders named for a family the Engine knows are used only by games
// of that family; everything else (the player's own folders, ambient sound, the interface's sounds, a
// family the Engine does not know) is shared. A game without a kit uses everything, as before.
// ──────────────────────────────────────────────
import { gameWorldKitFromMetadata } from "../../schemas/world-kit.schema.js";
import { WORLD_STARTER_KITS } from "./starter-kits.js";

/** The families the Engine knows: the folders it has always made, and the starter kits' own. */
export const WORLD_ART_FAMILIES = Object.freeze(["fantasy", "scifi", "modern", "wuxia", "jazz_age", "wasteland"]);

const KNOWN = new Set<string>(WORLD_ART_FAMILIES);

/** The bundled defaults that sit in shared folders, by the family they belong to. */
const BUNDLED: Readonly<Record<string, string>> = Object.freeze({
  "backgrounds:user:ancient_library": "fantasy",
  "backgrounds:user:castle_cliff": "fantasy",
  "backgrounds:user:enchanted_forest": "fantasy",
  "backgrounds:user:city_night": "modern",
  ...Object.fromEntries(
    [
      "chainmail",
      "knife-slice",
      "knife-slice-2",
      "magic-cast",
      "metal-ring",
      "spell-hit",
      "sword-swing",
      "sword-swing-2",
      "sword-swing-3",
      "sword-unsheathe",
    ].map((name) => [`sfx:combat:${name}`, "fantasy"]),
  ),
});

/** The folder segment of a tag that names a family, when the tag has one there. */
function familyFolder(tag: string): string | undefined {
  const parts = tag.split(":");
  if (parts[0] === "music") {
    // music:<state>:<family or genre>:<intensity>:<name>; an area or tier track (music:area:<slug>:<name>)
    // is shorter, and a game's own.
    return parts.length >= 5 ? parts[2] : undefined;
  }
  if (parts[0] === "backgrounds") return parts.length >= 3 ? parts[1] : undefined;
  if (parts[0] === "sprites") return parts[1]?.startsWith("generic-") ? parts[1].slice("generic-".length) : undefined;
  // sfx:<kind>:<family>:<name>
  if (parts[0] === "sfx") return parts.length >= 4 ? parts[2] : undefined;
  return undefined;
}

/** The family an asset belongs to, or undefined when it is shared. */
export function worldAssetFamily(tag: string): string | undefined {
  const bundled = BUNDLED[tag];
  if (bundled) return bundled;
  const folder = familyFolder(tag);
  return folder && KNOWN.has(folder) ? folder : undefined;
}

/** Whether a game of this family may use the asset; a game without a kit (no family) uses any. */
export function worldAssetUsable(tag: string, family: string | null | undefined): boolean {
  if (!family) return true;
  const own = worldAssetFamily(tag);
  return own === undefined || own === family;
}

/** The assets, by tag, that a game of this family may use. */
export function worldAssetsForFamily<T>(
  assets: Record<string, T> | null | undefined,
  family: string | null | undefined,
): Record<string, T> | null {
  if (!assets) return null;
  if (!family) return assets;
  return Object.fromEntries(Object.entries(assets).filter(([tag]) => worldAssetUsable(tag, family)));
}

const STARTER_FAMILY = new Map(WORLD_STARTER_KITS.map((kit) => [kit.id, kit.family]));

/** A kit's art family: its own, or for a kit saved before families its starter kit's by id. Undefined
 *  (every folder, as before) for no kit, or a kit of no starter's that names none. */
export function worldKitArtFamily(kit: { id: string; family?: string } | null | undefined): string | undefined {
  return kit ? (kit.family ?? STARTER_FAMILY.get(kit.id)) : undefined;
}

/** A game's art family, from its stored kit. */
export function gameArtFamily(metadata: Record<string, unknown> | null | undefined): string | undefined {
  return worldKitArtFamily(gameWorldKitFromMetadata(metadata));
}

/** The sound to play for an event's sound tag (`sfx:combat:sword-swing`) in a game of this family: the
 *  family's own (`sfx:combat:<family>:sword-swing`) when the game has it, the tag itself when the game
 *  may use it, and none otherwise, so a shoot-out is quiet rather than full of swords. */
export function worldFamilySound(
  tag: string,
  family: string | null | undefined,
  assets: Record<string, unknown> | null | undefined,
): string | null {
  if (!family) return tag;
  const parts = tag.split(":");
  if (parts.length === 3) {
    const own = `${parts[0]}:${parts[1]}:${family}:${parts[2]}`;
    if (assets?.[own]) return own;
  }
  return worldAssetUsable(tag, family) ? tag : null;
}
