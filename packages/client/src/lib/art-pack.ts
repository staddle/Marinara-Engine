// The game's icons and portraits (Capability API 1.338): a board pack of kind `icons` or
// `portraits`, the library's or the built-in one the server resolves. How one is drawn is
// `components/game/ArtIcon.tsx`; a thing the pack lacks keeps today's look.
import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import {
  artPortraitNeutral,
  boardPackSchema,
  boardPackSprite,
  type ArtPackKind,
  type BoardPack,
  type BoardPackSlice,
} from "@marinara-engine/shared";
import { api } from "./api-client";

/** Stands in where nothing provides a client (a sheet drawn on its own); it never asks. */
const idleClient = new QueryClient();

/** The pack of a kind, or null: none stored, none built in, or a server that does not answer. */
export function useArtPack(kind: ArtPackKind): BoardPack | null {
  const client = useContext(QueryClientContext);
  const { data } = useQuery(
    {
      queryKey: ["game", "art-pack", kind],
      queryFn: async (): Promise<BoardPack | null> => {
        try {
          const answer = await api.get<{ pack: unknown }>(`/game-tile-packs/boards/art?kind=${kind}`);
          const parsed = boardPackSchema.safeParse(answer.pack);
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      },
      staleTime: 5 * 60_000,
      enabled: client !== undefined,
    },
    client ?? idleClient,
  );
  return data ?? null;
}

/** The first of `ids` the pack draws, whole; a portrait's expression the pack lacks falls back to its
 *  neutral one. Null for none. */
export function artPackSlice(
  pack: BoardPack | null,
  ids: ReadonlyArray<string | null | undefined>,
): BoardPackSlice | null {
  if (!pack) return null;
  for (const id of ids) {
    if (!id) continue;
    const found =
      boardPackSprite([pack], id) ?? (id.includes("@") ? boardPackSprite([pack], artPortraitNeutral(id)) : null);
    if (found) return found;
  }
  return null;
}
