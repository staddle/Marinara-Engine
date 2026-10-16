import { useQuery } from "@tanstack/react-query";
import type { ExperienceMapPack } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

/** An installed Experience's map pack (worldgen W9e), as the Engine read and checked it; null when it
 *  ships none. An error carries why a declared pack does not read. */
export function useExperienceMapPack(packageId: string | null) {
  return useQuery({
    queryKey: ["game", "map-pack", packageId],
    queryFn: async () =>
      (
        await api.get<{ mapPack: ExperienceMapPack | null }>(
          `/game/experience-map-pack/${encodeURIComponent(packageId!)}`,
        )
      ).mapPack,
    enabled: Boolean(packageId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}
