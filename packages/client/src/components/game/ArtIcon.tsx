// One icon (Capability API 1.338) or portrait (1.338) from the game's art packs: the first of `ids` the
// pack has, drawn filling the box; without one, `fallback` (today's letter, text or picture).
import type { ReactNode } from "react";
import type { ArtPackKind } from "@marinara-engine/shared";
import { artPackSlice, useArtPack } from "../../lib/art-pack";
import { boardSliceStyle } from "../../lib/board-art-cells";
import { cn } from "../../lib/utils";

export function ArtIcon({
  kind = "icons",
  ids,
  className,
  fallback = null,
  label,
}: {
  kind?: ArtPackKind;
  ids: ReadonlyArray<string | null | undefined>;
  className?: string;
  fallback?: ReactNode;
  /** Said for it when it stands alone; left out where the words beside it already say it. */
  label?: string;
}) {
  const pack = useArtPack(kind);
  const slice = artPackSlice(pack, ids);
  if (!slice) return <>{fallback}</>;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-art={kind}
      className={cn("inline-block shrink-0", className)}
      style={boardSliceStyle(slice)}
    />
  );
}
