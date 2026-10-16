import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";

/** A world in the library (worldgen W9f), as the library lists it. */
export interface LibraryWorld {
  id: string;
  name: string;
  kit: string | null;
  seed: number | null;
  edited: boolean;
  story: boolean;
  reads: boolean;
}

/** The worlds made outside any game that this Engine can read, to start a new game from. */
export function useWorldLibrary(enabled = true) {
  return useQuery({
    queryKey: ["game", "world-library"],
    queryFn: async () =>
      (await api.get<{ worlds: LibraryWorld[] }>("/game-worlds")).worlds.filter((world) => world.reads),
    enabled,
    staleTime: 30_000,
  });
}

/** Whether this server lets players make Overworld games (MARINARA_OVERWORLD_GAMES); locked until it says so. */
export function useOverworldGamesEnabled() {
  const query = useQuery({
    queryKey: ["game", "overworld-enabled"],
    queryFn: async () => (await api.get<{ enabled: boolean }>("/game/overworld")).enabled === true,
    staleTime: 60_000,
  });
  return query.data === true;
}
