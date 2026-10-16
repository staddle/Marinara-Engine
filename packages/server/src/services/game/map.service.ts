// ──────────────────────────────────────────────
// Game: Map Generation Service
// ──────────────────────────────────────────────
import type { TacticalEnvironment, WorldBattlefields } from "@marinara-engine/shared";

/** Battlefields that are rooms and corridors rather than open ground. */
const ENCLOSED: ReadonlySet<TacticalEnvironment> = new Set(["dungeon", "cave", "castle", "mansion", "spaceship"]);

/** Build the prompt for generating a map of the current area. With the setting's own scenes (worldgen
 *  W6d), its open and enclosed places are the examples, never a fantasy forest and dungeon. */
export function buildMapGenerationPrompt(locationType: string, context: string, fields?: WorldBattlefields): string {
  const open = fields?.scenes.filter((scene) => !ENCLOSED.has(scene.like)).map((scene) => scene.label) ?? [];
  const enclosed = fields?.scenes.filter((scene) => ENCLOSED.has(scene.like)).map((scene) => scene.label) ?? [];
  const outdoor = open.length ? open.slice(0, 3).join(", ") : "overworld, city, forest";
  const indoor = enclosed.length ? enclosed.slice(0, 3).join(", ") : "dungeon, cave, building";
  return [
    `Generate a map for the current area in the RPG game.`,
    ``,
    `Location type: ${locationType}`,
    `Context: ${context}`,
    ``,
    `Rules:`,
    `- For outdoor areas (${outdoor}, etc.): generate a "grid" type map (6x6 to 8x8)`,
    `- For indoor areas (${indoor}, etc.): generate a "node" type map`,
    ``,
    `Grid map format:`,
    `{`,
    `  "type": "grid",`,
    `  "name": "Area Name",`,
    `  "description": "Brief area description",`,
    `  "width": 6, "height": 6,`,
    `  "cells": [{"x": 0, "y": 0, "emoji": "${open.length ? "📍" : "🌲"}", "label": "${open[0] ?? "Dense Forest"}", "discovered": true, "terrain": "forest"}],`,
    `  "partyPosition": {"x": 3, "y": 3}`,
    `}`,
    ``,
    `Node map format:`,
    `{`,
    `  "type": "node",`,
    `  "name": "${enclosed.length ? "Place Name" : "Dungeon Name"}",`,
    `  "description": "Brief ${enclosed.length ? "place" : "dungeon"} description",`,
    `  "nodes": [{"id": "entrance", "emoji": "🚪", "label": "Entrance", "x": 50, "y": 90, "discovered": true}],`,
    `  "edges": [{"from": "entrance", "to": "hallway1"}],`,
    `  "partyPosition": "entrance"`,
    `}`,
    ``,
    `Use diverse emojis for different terrain/room types. Mark the party's starting position as discovered.`,
    `Nearby cells/nodes should also be discovered; distant ones should be undiscovered (discovered: false).`,
    ``,
    `Output ONLY the JSON map object, no other text.`,
  ].join("\n");
}
