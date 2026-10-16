// ──────────────────────────────────────────────
// Game: inside a town building (worldgen W13)
// The rooms behind the door the party stands at: walls, floors and furniture in the setting's tiles, the
// people who are there at the hour (at work, or asleep in their beds), and the party just inside the way
// out. Looking only: the walk there already told the Game Master, with the rooms in words.
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { worldInteriorPeopleAt, type WorldPerson } from "@marinara-engine/shared";
import { useTownInterior, type TownState } from "../../hooks/use-game";
import type { OverworldTileDrawer } from "../../hooks/use-overworld-view";
import { OVERWORLD_TILE, cellNoise, paintParty } from "../../lib/overworld-paint";
import { cn } from "../../lib/utils";

interface TownInteriorProps {
  chatId: string;
  town: TownState;
  buildingId: string;
  hour: number;
  /** 0 by day; more at night, when lamps are lit inside. */
  darkness: number;
  drawTile: OverworldTileDrawer;
}

const T = OVERWORLD_TILE;
const PLAIN: Record<string, string> = {
  wall: "#4a3f35",
  floor: "#9b7a4a",
  door: "#5a3b22",
  furniture: "#6b4a2b",
};
const hash = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

export function TownInterior({ chatId, town, buildingId, hour, darkness, drawTile }: TownInteriorProps) {
  const { t } = useTranslation();
  const { data: interior, isError } = useTownInterior(chatId, buildingId);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<string | null>(null);

  const people = useMemo(() => (interior ? worldInteriorPeopleAt(town, interior, hour) : []), [hour, interior, town]);
  // The rooms fit above the narration, which covers the lower part of the view, under the top bar.
  const top = 96;
  const room = { width: size.width - 32, height: Math.max(120, size.height * 0.58 - top) };
  const scale = interior
    ? Math.max(
        1,
        Math.min(6, Math.floor(Math.min(room.width / (interior.width * T), room.height / (interior.height * T)))),
      )
    : 2;
  const cell = T * scale;
  const origin = interior
    ? {
        x: Math.round((size.width - interior.width * cell) / 2),
        y: Math.round(top + Math.max(0, (room.height - interior.height * cell) / 2)),
      }
    : { x: 0, y: 0 };

  const hasInterior = Boolean(interior);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasInterior]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !interior || size.width === 0 || drawTile.loading) return;
    const dpr = window.devicePixelRatio || 1;
    const [width, height] = [Math.round(size.width * dpr), Math.round(size.height * dpr)];
    if (canvas.width !== width || canvas.height !== height) [canvas.width, canvas.height] = [width, height];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#05060a";
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, origin.x * dpr, origin.y * dpr);
    // An image pack's art is drawn smooth where it is shown smaller than it was made.
    ctx.imageSmoothingEnabled = drawTile.image && drawTile.resolution > scale * dpr;
    const plain = (colour: string, x: number, y: number, inset = 0) => {
      ctx.fillStyle = colour;
      ctx.fillRect(x + inset, y + inset, T - inset * 2, T - inset * 2);
    };
    for (let y = 0; y < interior.height; y++) {
      for (let x = 0; x < interior.width; x++) {
        const c = interior.ground[y * interior.width + x];
        const [id, colour] =
          c === "#"
            ? ["in_wall", PLAIN.wall]
            : c === "d" || c === "D"
              ? ["in_door", PLAIN.door]
              : ["in_floor", PLAIN.floor];
        if (!drawTile(ctx, id!, x * T, y * T, cellNoise(x, y)(3))) plain(colour!, x * T, y * T);
      }
    }
    for (const piece of interior.furniture) {
      if (!drawTile(ctx, `in_${piece.kind}`, piece.x * T, piece.y * T))
        plain(PLAIN.furniture!, piece.x * T, piece.y * T, 3);
    }
    // Back to front, the party (just inside the way out, facing into the rooms) among them.
    const partyRow = interior.door.y - 1;
    const drawParty = () => {
      const [px, py] = [interior.door.x * T, (interior.door.y - 1) * T - 6];
      if (
        !drawTile.character(ctx, "party", interior.door.x * T, (interior.door.y - 1) * T, "up", 1) &&
        !drawTile(ctx, "party", px, py)
      )
        paintParty(ctx, px + 1, py + 1, false);
    };
    let partyDrawn = false;
    for (const { person, at, asleep } of [...people].sort((a, b) => a.at.y - b.at.y)) {
      if (!partyDrawn && at.y > partyRow) {
        drawParty();
        partyDrawn = true;
      }
      if (drawTile.character(ctx, { person: person.id }, at.x * T, at.y * T, "down", 1, asleep)) continue;
      const pick = (hash(person.id) % 100) / 100;
      if (asleep) ctx.globalAlpha = 0.75;
      if (!drawTile(ctx, "folk", at.x * T, at.y * T - (asleep ? 0 : 4), pick))
        paintParty(ctx, at.x * T + 1, at.y * T - 3, false);
      ctx.globalAlpha = 1;
    }
    if (!partyDrawn) drawParty();
    if (darkness > 0) {
      // Lamplight: warm, not the night outside.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = `rgba(255, 200, 140, ${Math.min(0.5, darkness)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    }
  }, [darkness, drawTile, interior, origin.x, origin.y, people, scale, size.height, size.width]);

  const chosen = selected ? people.find((each) => each.person.id === selected) : undefined;
  // Someone who has left (the hour turned) is no longer chosen.
  useEffect(() => {
    if (selected && !chosen) setSelected(null);
  }, [chosen, selected]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-[1] overflow-clip bg-black"
      role="region"
      aria-label={t("game.town.insideRegion")}
      data-component="TownInterior"
    >
      {isError && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          {t("game.town.insideFailed")}
        </div>
      )}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full [image-rendering:pixelated]" />
      {interior &&
        people.map(({ person, at }) => (
          <button
            key={person.id}
            type="button"
            onClick={() => setSelected(selected === person.id ? null : person.id)}
            className={cn(
              "absolute rounded-sm outline-none hover:ring-2 hover:ring-white/50 focus-visible:ring-2 focus-visible:ring-white",
              selected === person.id && "ring-2 ring-[var(--primary)]",
            )}
            style={{ left: origin.x + at.x * cell, top: origin.y + at.y * cell, width: cell, height: cell }}
            aria-label={personLabel(person)}
            aria-pressed={selected === person.id}
          />
        ))}
      {chosen && interior && (
        <div
          className={cn(
            "absolute z-10 w-56 -translate-x-1/2 rounded-xl border border-white/15 bg-black/80 p-3 text-xs text-white/85 shadow-xl backdrop-blur-md",
            // Above the person, or below them when they stand near the top.
            origin.y + chosen.at.y * cell > 220 && "-translate-y-full",
          )}
          style={{
            left: Math.min(Math.max(origin.x + chosen.at.x * cell + cell / 2, 120), size.width - 120),
            top:
              origin.y + chosen.at.y * cell > 220
                ? origin.y + chosen.at.y * cell - 8
                : origin.y + (chosen.at.y + 1) * cell + 8,
          }}
          data-component="TownInterior.Card"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 truncate text-sm font-semibold text-white">
              {chosen.person.named ? chosen.person.name : chosen.person.role}
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded p-0.5 text-white/50 hover:text-white"
              aria-label={t("game.overworld.close")}
            >
              <X size={12} />
            </button>
          </div>
          {chosen.person.named && <div className="mt-1 text-white/60">{chosen.person.role}</div>}
          <div className="mt-1 text-white/50">{chosen.asleep ? t("game.town.asleep") : t("game.town.awake")}</div>
        </div>
      )}
      {interior && people.length === 0 && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white/70">
          {t("game.town.nobody")}
        </div>
      )}
    </div>
  );

  function personLabel(person: WorldPerson) {
    return person.named ? `${person.name}, ${person.role}` : person.role;
  }
}
