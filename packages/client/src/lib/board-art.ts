// Which packs a fight's board is drawn with (fight-board art slots, Capability API 1.333): the board pack
// and the props pack the server resolves for it. How a cell draws from them is `board-art-cells.ts`.
import { useQuery } from "@tanstack/react-query";
import { boardPackSchema } from "@marinara-engine/shared";
import { api } from "./api-client";
import type { BoardArt } from "./board-art-cells";

export { boardCellArt, boardSliceStyle, type BoardArt, type BoardCellArt } from "./board-art-cells";

const NONE: BoardArt = { board: null, props: null };

/** The packs a board is drawn with: the one it names, else its environment's; and the props pack. None
 *  stored and none built in, or a server that does not answer: today's drawing. */
export function useBoardArt(pack: string | undefined, environment: string | undefined): BoardArt {
  const { data } = useQuery({
    queryKey: ["game", "board-art", pack ?? "", environment ?? ""],
    queryFn: async (): Promise<BoardArt> => {
      try {
        const query = new URLSearchParams();
        if (pack) query.set("pack", pack);
        if (environment) query.set("environment", environment);
        const answer = await api.get<{ board: unknown; props: unknown }>(`/game-tile-packs/boards/for?${query}`);
        const read = (value: unknown) => {
          const parsed = boardPackSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        };
        return { board: read(answer.board), props: read(answer.props) };
      } catch {
        return NONE;
      }
    },
    staleTime: 5 * 60_000,
  });
  return data ?? NONE;
}
