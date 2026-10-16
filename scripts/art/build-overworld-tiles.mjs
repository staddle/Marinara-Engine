#!/usr/bin/env node
// ──────────────────────────────────────────────
// The overworld's tiles (worldgen W8), drawn in code: every ground look, the settlement markers by
// size, a place in ruins and the party, for each setting family, from that family's palette. Shading,
// not outlines. Deterministic: the same script always writes the same pixels.
//
//   pnpm art:overworld   (node scripts/art/build-overworld-tiles.mjs)
//
// The Engine's own base set, replacing the placeholder tiles W8 began with (the user, 2026-10-02: our
// own base assets, and community asset packs later in the same format). Change the art here and rerun;
// the world-overworld lane checks the committed images are this script's.
//
// Writes packages/server/src/assets/overworld-tiles/<family>.json: each family's tile pack (the shared tile-pack
// format: a palette, and every tile's variants as sixteen rows of sixteen characters).
// ──────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.OVERWORLD_TILES_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = 16;

// ── Pixels ──

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
const tile = () => new Uint8ClampedArray(T * T * 4);
function px(t, x, y, colour, alpha = 255) {
  if (!colour || x < 0 || y < 0 || x >= T || y >= T) return;
  const [r, g, b] = typeof colour === "string" ? hex(colour) : colour;
  const i = (Math.floor(y) * T + Math.floor(x)) * 4;
  if (alpha >= 255) {
    t.set([r, g, b, 255], i);
    return;
  }
  const a = alpha / 255;
  const under = t[i + 3] / 255;
  const out = a + under * (1 - a);
  if (out === 0) return;
  t[i] = (r * a + t[i] * under * (1 - a)) / out;
  t[i + 1] = (g * a + t[i + 1] * under * (1 - a)) / out;
  t[i + 2] = (b * a + t[i + 2] * under * (1 - a)) / out;
  t[i + 3] = out * 255;
}
const rect = (t, x, y, w, h, colour, alpha) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(t, xx, yy, colour, alpha);
};
const fill = (t, colour) => rect(t, 0, 0, T, T, colour);
/** A sprite from rows of characters, each a palette role (or "." for nothing). */
function sprite(t, x0, y0, rows, colours) {
  rows.forEach((row, y) => [...row].forEach((c, x) => c !== "." && px(t, x0 + x, y0 + y, colours[c])));
}

// A number 0..1 for (x, y) and the nth thing drawn: the same tile always draws the same way.
function noise(x, y, n) {
  let h = Math.imul(x * 374761393 + y * 668265263 + n * 2246822519, 3266489917) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
const speckle = (t, colour, count, seed, size = 1) => {
  for (let i = 0; i < count; i++)
    rect(
      t,
      Math.floor(noise(seed, i, 1) * (T - size + 1)),
      Math.floor(noise(seed, i, 2) * (T - size + 1)),
      size,
      size,
      colour,
    );
};

// ── Palettes: the colours each family is drawn in, by role ──

const PALETTES = {
  fantasy: {
    grass: "#6aa84f",
    grassLight: "#8cc265",
    grassDark: "#4f8a3c",
    leaf: "#3f8a3a",
    leafLight: "#5fae4c",
    leafDark: "#2c6630",
    trunk: "#6b4a2b",
    soil: "#9b7a4a",
    soilDark: "#7a5c36",
    crop: "#c9b458",
    cropDark: "#8fa443",
    sand: "#e0cc8e",
    sandDark: "#c8b06e",
    snow: "#eef3f7",
    snowShade: "#c9d6e2",
    rock: "#8f8a80",
    rockLight: "#b3ada2",
    rockDark: "#6a655d",
    water: "#3f78b8",
    waterLight: "#6a9fd6",
    waterDeep: "#2d5a94",
    wall: "#efe2c2",
    wallShade: "#cdbd98",
    roof: "#b5523b",
    roofShade: "#8a3a2a",
    door: "#5a3b22",
    stone: "#a8a294",
    stoneDark: "#7c776b",
    accent: "#d9b44a",
    skin: "#f1c9a5",
    hair: "#5a3b22",
    cloak: "#3a6fd8",
    cloakShade: "#28509e",
  },
  wuxia: {
    grass: "#7aaa5a",
    grassLight: "#9cc47a",
    grassDark: "#5c8c46",
    leaf: "#3d7a52",
    leafLight: "#5c9c6a",
    leafDark: "#2a5a3c",
    trunk: "#5a4a3a",
    soil: "#a08a62",
    soilDark: "#7e6a48",
    crop: "#a8c46a",
    cropDark: "#7aa04c",
    sand: "#d8c89a",
    sandDark: "#bca878",
    snow: "#eef2f0",
    snowShade: "#c4d0cc",
    rock: "#7c8488",
    rockLight: "#a4acae",
    rockDark: "#565e64",
    water: "#4a8a9c",
    waterLight: "#78b0bc",
    waterDeep: "#336a7c",
    wall: "#efe6d2",
    wallShade: "#cfc2a6",
    roof: "#3a5a5a",
    roofShade: "#24403e",
    door: "#a8322a",
    stone: "#b0aa9c",
    stoneDark: "#86806f",
    accent: "#c8402e",
    skin: "#f0caa4",
    hair: "#1e1a18",
    cloak: "#e9e4d6",
    cloakShade: "#bdb6a2",
  },
  modern: {
    grass: "#78ac58",
    grassLight: "#98c476",
    grassDark: "#5a8c42",
    leaf: "#4a8c48",
    leafLight: "#6aac5c",
    leafDark: "#336a34",
    trunk: "#6a5038",
    soil: "#a48a5c",
    soilDark: "#826a42",
    crop: "#c4b85a",
    cropDark: "#8eac48",
    sand: "#e2d0a0",
    sandDark: "#c8b47e",
    snow: "#f0f4f8",
    snowShade: "#cad6e2",
    rock: "#8e8c88",
    rockLight: "#b2b0aa",
    rockDark: "#686660",
    water: "#3c7ec4",
    waterLight: "#6aa6e0",
    waterDeep: "#2a5e9c",
    wall: "#dfe3e8",
    wallShade: "#b4bac4",
    roof: "#5a6470",
    roofShade: "#3e4650",
    door: "#3e4a5a",
    stone: "#9a9ca0",
    stoneDark: "#707276",
    accent: "#e0a83a",
    skin: "#e8bd98",
    hair: "#3a2a1e",
    cloak: "#e0a83a",
    cloakShade: "#b07e24",
  },
  jazz_age: {
    grass: "#8a9a5c",
    grassLight: "#a8b47a",
    grassDark: "#6c7c46",
    leaf: "#5a7444",
    leafLight: "#768e5a",
    leafDark: "#425632",
    trunk: "#5e4632",
    soil: "#a08660",
    soilDark: "#7c6644",
    crop: "#c4ac68",
    cropDark: "#96904e",
    sand: "#d8c49a",
    sandDark: "#baa478",
    snow: "#ece8e0",
    snowShade: "#c8c2b6",
    rock: "#8a8274",
    rockLight: "#aca492",
    rockDark: "#665e52",
    water: "#4a7088",
    waterLight: "#7096aa",
    waterDeep: "#36546a",
    wall: "#b8664a",
    wallShade: "#8e4a34",
    roof: "#4a3e36",
    roofShade: "#302822",
    door: "#2e2620",
    stone: "#a49a88",
    stoneDark: "#7a7062",
    accent: "#d8b45a",
    skin: "#ecc8a2",
    hair: "#2a2018",
    cloak: "#4a4a52",
    cloakShade: "#32323a",
  },
  scifi: {
    grass: "#3e6a6a",
    grassLight: "#548888",
    grassDark: "#2c5050",
    leaf: "#2a7a6a",
    leafLight: "#3aa08a",
    leafDark: "#1c5448",
    trunk: "#3a4a52",
    soil: "#5a5662",
    soilDark: "#42404a",
    crop: "#4ac0a8",
    cropDark: "#2e8a7a",
    sand: "#a89a86",
    sandDark: "#8a7c6a",
    snow: "#dfeaf2",
    snowShade: "#b4c4d2",
    rock: "#6a6e7a",
    rockLight: "#8e94a2",
    rockDark: "#4a4e58",
    water: "#24546e",
    waterLight: "#3a86a4",
    waterDeep: "#173c52",
    wall: "#cfe4ee",
    wallShade: "#94b0c0",
    roof: "#7ae0f0",
    roofShade: "#3aa8c0",
    door: "#1e2a36",
    stone: "#7a808c",
    stoneDark: "#545a66",
    accent: "#f06ad8",
    skin: "#e8c8b0",
    hair: "#d8e8f0",
    cloak: "#f06ad8",
    cloakShade: "#b040a0",
  },
  wasteland: {
    grass: "#9c8c5e",
    grassLight: "#b4a676",
    grassDark: "#7c6e46",
    leaf: "#6c6a3e",
    leafLight: "#8a8650",
    leafDark: "#4e4c2c",
    trunk: "#4e3e2e",
    soil: "#a07e58",
    soilDark: "#7a5e40",
    crop: "#a89a5a",
    cropDark: "#80784a",
    sand: "#d0b484",
    sandDark: "#b09466",
    snow: "#e2ddd2",
    snowShade: "#bdb5a6",
    rock: "#857a6c",
    rockLight: "#a69a88",
    rockDark: "#5e554a",
    water: "#4e6a66",
    waterLight: "#6e8a84",
    waterDeep: "#3a504c",
    wall: "#a88a66",
    wallShade: "#806648",
    roof: "#8a5a3a",
    roofShade: "#643e28",
    door: "#3a2c20",
    stone: "#8e8676",
    stoneDark: "#665e52",
    accent: "#d86a2e",
    skin: "#dcb08c",
    hair: "#4a3424",
    cloak: "#c8743a",
    cloakShade: "#92502a",
  },
};
const SPACE = {
  space: "#0b0d1a",
  star: "#e8ecff",
  starDim: "#8a90b8",
  nebula: "#2a1c48",
  nebulaLight: "#6a4aa8",
  rock: "#7a7670",
  rockLight: "#a29e96",
  rockDark: "#4e4b47",
  well: "#06060c",
  ring: "#7a62e0",
};

// ── Ground ──

function ground(p, base, light, dark, seed, density = 1) {
  const t = tile();
  fill(t, p[base]);
  speckle(t, p[light], Math.round(7 * density), seed);
  speckle(t, p[dark], Math.round(5 * density), seed + 50);
  return t;
}
function tuft(t, x, y, p) {
  px(t, x, y + 1, p.grassDark);
  px(t, x + 1, y, p.grassLight);
  px(t, x + 2, y + 1, p.grassDark);
}
function roundTree(t, x, y, p) {
  sprite(t, x, y, [".llL.", "lLLLd", "lLLLd", ".dLd.", "..t..", "..t.."], {
    l: p.leafLight,
    L: p.leaf,
    d: p.leafDark,
    t: p.trunk,
  });
  px(t, x + 1, y + 6, p.grassDark);
  px(t, x + 3, y + 6, p.grassDark);
}
function pine(t, x, y, p) {
  sprite(t, x, y, ["..l..", ".lLd.", "..L..", ".lLd.", "lLLLd", "..t.."], {
    l: p.leafLight,
    L: p.leaf,
    d: p.leafDark,
    t: p.trunk,
  });
}
function bareTree(t, x, y, p) {
  sprite(t, x, y, ["t...t", ".t.t.", "..t..", "..t..", "..t.."], { t: p.trunk });
}
function mound(t, x, y, p, w = 9) {
  for (let row = 0; row < 4; row++) {
    const half = Math.round((w / 2) * Math.sqrt(1 - ((3 - row) / 4) ** 2));
    for (let dx = -half; dx <= half; dx++)
      px(t, x + dx, y + row, row === 3 ? p.leafDark : dx < 0 ? p.grassLight : p.grassDark);
  }
  px(t, x - 1, y, p.grassLight);
}
function peak(t, x, y, p, h = 10) {
  for (let row = 0; row < h; row++) {
    const half = Math.floor(row * 0.6);
    for (let dx = -half; dx <= half; dx++) px(t, x + dx, y + row, dx <= 0 ? p.rockLight : p.rockDark);
    if (row < 3) for (let dx = -half; dx <= half; dx++) px(t, x + dx, y + row, dx <= 0 ? p.snow : p.snowShade);
  }
}
function waves(t, crest, seed, count = 2) {
  for (let i = 0; i < count; i++) {
    const x = 1 + Math.floor(noise(seed, i, 3) * 10);
    const y = 2 + Math.floor(noise(seed, i, 4) * 11);
    rect(t, x, y, 3, 1, crest);
    rect(t, x + 3, y - 1, 2, 1, crest);
  }
}
function house(t, x, y, p, style, w = 6, h = 4) {
  // A shadow on the ground, the wall with a shaded side, the roof in the family's style, a door.
  rect(t, x + 1, y + h + 2, w, 1, "#000000", 70);
  rect(t, x, y + 2, w, h, p.wall);
  rect(t, x + w - 1, y + 2, 1, h, p.wallShade);
  px(t, x + Math.floor(w / 2), y + h + 1, p.door);
  px(t, x + Math.floor(w / 2), y + h, p.door);
  if (style === "gable") {
    rect(t, x - 1, y + 1, w + 2, 1, p.roofShade);
    rect(t, x, y, w, 1, p.roof);
    rect(t, x + 1, y - 1, w - 2, 1, p.roof);
  } else if (style === "pagoda") {
    rect(t, x - 1, y + 1, w + 2, 1, p.roof);
    px(t, x - 2, y, p.roof);
    px(t, x + w + 1, y, p.roof);
    rect(t, x, y, w, 1, p.roofShade);
    rect(t, x + 1, y - 1, w - 2, 1, p.roof);
  } else if (style === "flat") {
    rect(t, x, y + 1, w, 1, p.roof);
    rect(t, x, y + 2, w, 1, p.roofShade);
  } else if (style === "dome") {
    rect(t, x + 1, y, w - 2, 1, p.roof);
    rect(t, x, y + 1, w, 1, p.roof);
    rect(t, x + w - 2, y, 1, 2, p.roofShade);
  } else if (style === "tent") {
    for (let row = 0; row < h + 2; row++) {
      const half = Math.floor(row / 2);
      rect(t, x + Math.floor(w / 2) - half, y + row, half * 2 + 1, 1, row % 2 ? p.roof : p.roofShade);
    }
  }
}
function tower(t, x, y, p, style) {
  // The landmark of a big place: a keep, a pagoda, a tower block, a spire, a fort.
  rect(t, x + 1, y + 12, 6, 1, "#000000", 70);
  if (style === "pagoda") {
    for (const [dy, w] of [
      [0, 4],
      [3, 6],
      [6, 8],
    ]) {
      rect(t, x + (8 - w) / 2, y + dy + 1, w, 2, p.wall);
      rect(t, x + (8 - w) / 2 - 1, y + dy, w + 2, 1, p.roof);
    }
    rect(t, x + 3, y + 9, 2, 3, p.door);
    rect(t, x + 1, y + 9, 6, 3, p.wall);
    rect(t, x + 3, y + 10, 2, 2, p.door);
    return;
  }
  if (style === "flat") {
    rect(t, x + 1, y, 6, 12, p.wall);
    rect(t, x + 5, y, 2, 12, p.wallShade);
    for (let wy = 1; wy < 11; wy += 2) for (let wx = 2; wx < 6; wx += 2) px(t, x + wx, y + wy, p.roofShade);
    rect(t, x + 1, y, 6, 1, p.roof);
    return;
  }
  if (style === "dome") {
    rect(t, x + 3, y, 2, 4, p.wallShade);
    px(t, x + 3, y, p.accent);
    rect(t, x + 1, y + 4, 6, 2, p.roof);
    rect(t, x, y + 6, 8, 6, p.wall);
    rect(t, x + 6, y + 6, 2, 6, p.wallShade);
    rect(t, x + 3, y + 9, 2, 3, p.door);
    return;
  }
  // A keep (fantasy, the 1920s' town hall, the wasteland's fort), crenellated.
  rect(t, x + 1, y + 2, 6, 10, p.stone);
  rect(t, x + 5, y + 2, 2, 10, p.stoneDark);
  for (let cx = x + 1; cx < x + 7; cx += 2) px(t, cx, y + 1, p.stone);
  rect(t, x + 3, y + 9, 2, 3, p.door);
  px(t, x + 3, y + 5, p.door);
  if (style === "gable") (rect(t, x + 3, y - 2, 1, 3, p.trunk), rect(t, x + 4, y - 2, 2, 1, p.accent));
}

function grounds(p) {
  const g = (seed, density) => ground(p, "grass", "grassLight", "grassDark", seed, density);
  const water = (base, light, seed) => {
    const t = tile();
    fill(t, p[base]);
    waves(t, p[light], seed);
    return t;
  };
  return {
    grass: [1, 2, 3, 4].map((s) => {
      const t = g(s);
      if (s % 2) tuft(t, 3 + s, 6 + s, p);
      return t;
    }),
    plains: [5, 6].map((s) => {
      const t = ground(p, "grassLight", "sandDark", "grass", s, 0.8);
      tuft(t, 4 + s, 9, p);
      return t;
    }),
    farmland: [7, 8].map((s) => {
      const t = tile();
      fill(t, p.soil);
      for (let y = 1; y < T; y += 3) rect(t, 0, y, T, 1, s === 7 ? p.crop : p.cropDark);
      for (let y = 2; y < T; y += 3) rect(t, 0, y, T, 1, p.soilDark);
      return t;
    }),
    forest: [9, 10, 11, 12].map((s) => {
      const t = ground(p, "grassDark", "leafDark", "leaf", s, 0.6);
      const kinds = s % 2 ? [roundTree, pine, roundTree] : [pine, roundTree, pine];
      kinds[0](t, Math.floor(noise(s, 0, 5) * 3), 0, p);
      kinds[1](t, 9 + Math.floor(noise(s, 1, 5) * 2), 2 + Math.floor(noise(s, 2, 5) * 2), p);
      kinds[2](t, 4 + Math.floor(noise(s, 3, 5) * 3), 9, p);
      return t;
    }),
    hills: [13, 14, 15, 16].map((s) => {
      const t = g(s, 0.7);
      // Half the hill cells are open slope between the mounds, so a range of hills does not repeat.
      if (s === 13) mound(t, 7, 7, p, 11);
      else if (s === 14) mound(t, 4, 10, p, 7);
      else tuft(t, 3 + (s % 3) * 3, 6 + (s % 2) * 4, p);
      return t;
    }),
    marsh: [17, 18].map((s) => {
      const t = ground(p, "grassDark", "grass", "leafDark", s, 0.8);
      rect(t, 2 + (s % 3), 4, 5, 2, p.water);
      rect(t, 8, 10 - (s % 2), 6, 2, p.water);
      for (const x of [3, 9, 13]) rect(t, x, 8 + (s % 2), 1, 3, p.leafDark);
      return t;
    }),
    paddies: [19, 20].map((s) => {
      const t = tile();
      fill(t, p.soil);
      rect(t, 1, 1, 14, 14, p.water);
      for (let y = 3; y < 14; y += 3)
        for (let x = 2 + (y % 2); x < 14; x += 2) px(t, x, y, s === 19 ? p.cropDark : p.crop);
      rect(t, 1, 1, 14, 1, p.waterLight);
      return t;
    }),
    bamboo: [21, 22].map((s) => {
      const t = g(s, 0.5);
      for (let i = 0; i < 4; i++) {
        const x = 2 + i * 4 + Math.floor(noise(s, i, 6) * 2);
        const top = Math.floor(noise(s, i, 7) * 4);
        rect(t, x, top, 1, T - top, p.leaf);
        for (let y = top + 3; y < T; y += 4) px(t, x, y, p.leafDark);
        px(t, x + 1, top + 2, p.leafLight);
        px(t, x - 1, top + 5, p.leafLight);
      }
      return t;
    }),
    scrub: [23, 24].map((s) => {
      const t = ground(p, "sand", "sandDark", "soil", s, 0.7);
      sprite(t, 3 + (s % 4), 5, [".lL.", "lLLd", ".dd."], { l: p.leafLight, L: p.leaf, d: p.leafDark });
      sprite(t, 10, 10 - (s % 3), [".L.", "LLd"], { L: p.leaf, d: p.leafDark });
      return t;
    }),
    desert: [25, 26, 27].map((s) => {
      const t = ground(p, "sand", "sandDark", "sandDark", s, 0.4);
      for (let x = 2; x < 13; x++) px(t, x, 5 + Math.round(Math.sin((x + s) / 2)), p.sandDark);
      if (s === 26) sprite(t, 9, 7, [".L.", "LLL", ".L.", ".L."], { L: p.cropDark });
      return t;
    }),
    snow: [28, 29].map((s) => {
      const t = ground(p, "snow", "snowShade", "snowShade", s, 0.6);
      if (s === 29) pine(t, 6, 5, p);
      return t;
    }),
    suburb: [30, 31, 32].map((s) => {
      const t = g(s, 0.5);
      rect(t, 0, 7, T, 2, p.stone);
      house(t, 1 + (s % 2), 1, p, "gable", 5, 3);
      house(t, 9, 10, p, s === 31 ? "flat" : "gable", 5, 3);
      return t;
    }),
    city: [33, 34, 35, 36].map((s) => {
      const t = tile();
      fill(t, p.stoneDark);
      for (const [x, y, w, h] of [
        [1, 1, 6, 6],
        [9, 1, 6, 6],
        [1, 9, 6, 6],
        [9, 9, 6, 6],
      ]) {
        const tall = noise(s, x, y) > 0.5;
        rect(t, x, y, w, h, tall ? p.roof : p.wall);
        rect(t, x + w - 1, y, 1, h, tall ? p.roofShade : p.wallShade);
        rect(t, x, y + h - 1, w, 1, tall ? p.roofShade : p.wallShade);
      }
      return t;
    }),
    industry: [37, 38].map((s) => {
      const t = tile();
      fill(t, p.soilDark);
      rect(t, 1, 5, 9, 8, p.stone);
      rect(t, 1, 5, 9, 1, p.stoneDark);
      for (let x = 1; x < 10; x += 3) rect(t, x, 4, 2, 1, p.stoneDark);
      rect(t, 11, 2 + (s % 2), 2, 11, p.rockDark);
      px(t, 12, 1 + (s % 2), p.rockLight);
      px(t, 13, 0 + (s % 2), p.rockLight);
      return t;
    }),
    slums: [39, 40].map((s) => {
      const t = ground(p, "soil", "soilDark", "soilDark", s, 0.5);
      for (let i = 0; i < 5; i++) {
        const x = Math.floor(noise(s, i, 8) * 12);
        const y = Math.floor(noise(s, i, 9) * 12);
        rect(t, x, y, 4, 3, [p.roof, p.stone, p.wallShade, p.rock][i % 4]);
        rect(t, x, y + 2, 4, 1, p.soilDark);
      }
      return t;
    }),
    wasteland: [41, 42].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.6);
      let x = 2 + (s % 4);
      for (let y = 3; y < 13; y++) {
        px(t, x, y, p.soilDark);
        x += noise(s, y, 10) > 0.5 ? 1 : -1;
      }
      return t;
    }),
    ruins: [43, 44].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.4);
      rect(t, 2, 4, 1, 8, p.stone);
      rect(t, 2, 11, 9, 1, p.stone);
      rect(t, 3, 4, 1, 3 + (s % 3), p.stoneDark);
      rect(t, 10, 8, 1, 4, p.stoneDark);
      speckle(t, p.stone, 4, s + 90);
      return t;
    }),
    // More forests (user, 2026-10-05): conifers for cold regions, autumn broadleaf, and jungle.
    conifer_forest: [70, 71].map((s) => {
      const t = ground(p, "grassDark", "leafDark", "leaf", s, 0.6);
      pine(t, Math.floor(noise(s, 0, 5) * 3), 0, p);
      pine(t, 9 + Math.floor(noise(s, 1, 5) * 2), 2 + Math.floor(noise(s, 2, 5) * 2), p);
      pine(t, 4 + Math.floor(noise(s, 3, 5) * 3), 9, p);
      return t;
    }),
    autumn_forest: [72, 73].map((s) => {
      const autumn = { ...p, leaf: "#c27a34", leafLight: "#dda04a", leafDark: "#8e4a22" };
      const t = ground(p, "grassDark", "soil", "grass", s, 0.6);
      roundTree(t, Math.floor(noise(s, 0, 5) * 3), 0, autumn);
      roundTree(t, 9 + Math.floor(noise(s, 1, 5) * 2), 2 + Math.floor(noise(s, 2, 5) * 2), autumn);
      roundTree(t, 4 + Math.floor(noise(s, 3, 5) * 3), 9, autumn);
      return t;
    }),
    jungle: [74, 75].map((s) => {
      const lush = { ...p, leaf: "#2f7a36", leafLight: "#4fa048", leafDark: "#1d5226" };
      const t = ground(lush, "leafDark", "leaf", "leafDark", s, 0.7);
      roundTree(t, Math.floor(noise(s, 0, 5) * 2), 0, lush);
      roundTree(t, 8 + Math.floor(noise(s, 1, 5) * 2), 1, lush);
      roundTree(t, 2 + Math.floor(noise(s, 2, 5) * 3), 7, lush);
      roundTree(t, 9, 9, lush);
      return t;
    }),
    dead_forest: [45, 46].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.5);
      bareTree(t, 2 + (s % 3), 2, p);
      bareTree(t, 9, 8, p);
      return t;
    }),
    space: [47, 48, 49].map((s) => {
      const t = tile();
      fill(t, SPACE.space);
      speckle(t, SPACE.starDim, 3, s);
      speckle(t, SPACE.star, 1 + (s % 2), s + 30);
      return t;
    }),
    nebula: [50, 51].map((s) => {
      const t = tile();
      fill(t, SPACE.nebula);
      speckle(t, SPACE.nebulaLight, 6, s, 2);
      speckle(t, SPACE.star, 2, s + 30);
      return t;
    }),
    asteroids: [52, 53, 54].map((s) => {
      const t = tile();
      fill(t, SPACE.space);
      speckle(t, SPACE.starDim, 2, s);
      sprite(t, 3 + (s % 5), 4 + (s % 4), [".lL.", "lLLd", "LLdd", ".dd."], {
        l: SPACE.rockLight,
        L: SPACE.rock,
        d: SPACE.rockDark,
      });
      return t;
    }),
    sea: [55, 56].map((s) => water("waterDeep", "water", s)),
    lake: [57, 58].map((s) => water("water", "waterLight", s)),
    toxic_water: [59].map((s) => {
      const t = tile();
      fill(t, "#5a7a2a");
      waves(t, "#9cc43a", s);
      speckle(t, "#c4e05a", 3, s + 9);
      return t;
    }),
    mountains: [60, 61].map((s) => {
      const t = g(s, 0.5);
      peak(t, 7 + (s % 2), 3, p, 11);
      if (s === 61) peak(t, 12, 8, p, 6);
      return t;
    }),
    craters: [62].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.5);
      rect(t, 4, 5, 7, 5, p.soilDark);
      rect(t, 5, 4, 5, 1, p.sandDark);
      rect(t, 5, 6, 5, 3, p.rockDark);
      return t;
    }),
    gravity_well: [63].map(() => {
      const t = tile();
      fill(t, SPACE.well);
      for (let a = 0; a < 32; a++)
        px(t, 8 + Math.cos((a / 32) * Math.PI * 2) * 6, 8 + Math.sin((a / 32) * Math.PI * 2) * 6, SPACE.ring);
      px(t, 7, 7, SPACE.starDim);
      return t;
    }),
  };
}

// ── Settlements, ruins and the party ──

const STYLE = {
  fantasy: { house: "gable", landmark: "gable" },
  wuxia: { house: "pagoda", landmark: "pagoda" },
  modern: { house: "flat", landmark: "flat" },
  jazz_age: { house: "gable", landmark: "flat" },
  scifi: { house: "dome", landmark: "dome" },
  wasteland: { house: "tent", landmark: "keep" },
};

function markers(p, style) {
  const tiers = [tile(), tile(), tile(), tile()];
  house(tiers[0], 5, 6, p, style.house);
  house(tiers[1], 1, 8, p, style.house, 5, 3);
  house(tiers[1], 8, 4, p, style.house);
  house(tiers[2], 1, 9, p, style.house, 5, 3);
  house(tiers[2], 9, 9, p, style.house, 5, 3);
  house(tiers[2], 5, 2, p, style.house);
  tower(tiers[3], 4, 2, p, style.landmark);
  house(tiers[3], 0, 10, p, style.house, 4, 3);
  house(tiers[3], 12, 10, p, style.house, 4, 3);
  const ruin = tile();
  rect(ruin, 3, 6, 1, 7, p.stone);
  rect(ruin, 3, 12, 9, 1, p.stone);
  rect(ruin, 11, 9, 1, 3, p.stoneDark);
  rect(ruin, 4, 6, 2, 1, p.stoneDark);
  speckle(ruin, p.stoneDark, 5, 77);
  rect(ruin, 2, 13, 11, 1, "#000000", 60);
  return { tiers, ruin };
}

function party(p) {
  const t = tile();
  rect(t, 5, 14, 6, 1, "#000000", 90);
  sprite(t, 5, 1, ["..hh..", ".hssh.", "..ss..", ".cCCc.", "cCCCCc", "cCCCCc", ".cCCc.", ".l..l.", ".l..l."], {
    h: p.hair,
    s: p.skin,
    c: p.cloakShade,
    C: p.cloak,
    l: p.trunk,
  });
  // A light rim on the cloak's lit side, so the party reads on any ground.
  for (let y = 5; y < 9; y++) px(t, 5, y, "#ffffff", 90);
  return t;
}

// ── Towns (worldgen W8b): streets, the square, roofs and fronts by the family's style, and townsfolk ──

/** The street each family paves: cobbles, flagstones, asphalt or a dirt track. */
const STREET = {
  fantasy: "cobble",
  wuxia: "flag",
  modern: "asphalt",
  jazz_age: "cobble",
  scifi: "asphalt",
  wasteland: "dirt",
};
/** The nine places of a roof: its corners, edges and middle. */
const NINE = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"];

function street(p, kind, seed) {
  const t = tile();
  if (kind === "asphalt") {
    fill(t, p.rockDark);
    speckle(t, p.stoneDark, 6, seed);
    if (seed % 2) (rect(t, 7, 2, 2, 4, p.accent), rect(t, 7, 10, 2, 4, p.accent));
  } else if (kind === "dirt") {
    fill(t, p.soil);
    speckle(t, p.soilDark, 8, seed);
    speckle(t, p.sandDark, 4, seed + 7);
  } else {
    fill(t, kind === "flag" ? p.stoneDark : p.stone);
    const size = kind === "flag" ? 8 : 4;
    for (let y = 0; y < T; y += size) rect(t, 0, y, T, 1, kind === "flag" ? p.rockDark : p.stoneDark);
    for (let y = 0; y < T; y += size)
      for (let x = (y / size) % 2 ? size / 2 : 0; x < T; x += size)
        rect(t, x, y, 1, size, kind === "flag" ? p.rockDark : p.stoneDark);
    speckle(t, kind === "flag" ? p.stone : p.rockLight, 3, seed);
  }
  return t;
}

/** One of a roof's nine places, in the family's style and a colour pair (homes, or halls and shops). */
function roofTile(style, at, roof, shade, light, accent) {
  const t = tile();
  const [north, south, west, east] = [at.startsWith("n"), at.startsWith("s"), at.endsWith("w"), at.endsWith("e")];
  fill(t, roof);
  if (style === "flat") {
    speckle(t, shade, 4, NINE.indexOf(at) + 3);
    if (north) rect(t, 0, 0, T, 2, light);
    if (south) rect(t, 0, T - 2, T, 2, shade);
    if (west) rect(t, 0, 0, 2, T, light);
    if (east) rect(t, T - 2, 0, 2, T, shade);
    if (at === "c") (rect(t, 6, 6, 4, 4, shade), rect(t, 7, 7, 2, 2, light));
    return t;
  }
  if (style === "tent") {
    for (let x = 0; x < T; x += 4) rect(t, x, 0, 2, T, shade);
    if (north) rect(t, 0, 0, T, 1, light);
    if (south) rect(t, 0, T - 2, T, 2, shade);
    return t;
  }
  if (style === "dome") {
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const dx = west ? T - x : east ? x : T;
        const dy = north ? T - y : south ? y : T;
        if ((west || east) && (north || south) && Math.hypot(dx, dy) > T)
          (px(t, x, y, [0, 0, 0], 0), (t[(y * T + x) * 4 + 3] = 0));
      }
    if (north && !west && !east) rect(t, 0, 2, T, 1, light);
    if (at === "c" || at === "n") rect(t, 4, 4, 3, 2, light);
    if (south) rect(t, 0, T - 2, T, 2, shade);
    return t;
  }
  // Gable and pagoda: rows of shingles, a ridge along the top, dark eaves along the bottom.
  for (let y = 3; y < T; y += 4) rect(t, 0, y, T, 1, shade);
  for (let y = 1; y < T; y += 4) for (let x = y % 8 === 1 ? 0 : 3; x < T; x += 6) px(t, x, y, shade);
  if (north) rect(t, 0, 0, T, 2, style === "pagoda" ? accent : light);
  if (south) rect(t, 0, T - 3, T, 3, shade);
  if (west) rect(t, 0, 0, 1, T, shade);
  if (east) rect(t, T - 1, 0, 1, T, shade);
  if (style === "pagoda" && south && (west || east)) {
    // The eaves curl up at the corners.
    const x = west ? 0 : T - 3;
    rect(t, x, T - 5, 3, 2, accent);
  }
  return t;
}

function front(p, kind) {
  const t = tile();
  fill(t, p.wall);
  rect(t, 0, 0, T, 2, p.wallShade);
  rect(t, 0, T - 1, T, 1, p.wallShade);
  if (kind === "window") {
    rect(t, 5, 5, 6, 5, p.door);
    rect(t, 6, 6, 4, 3, "#3a4a5a");
    px(t, 6, 6, "#8aa4bc");
  } else if (kind === "door") {
    rect(t, 5, 4, 6, 12, p.door);
    px(t, 9, 10, p.accent);
  }
  return t;
}

function stall(p) {
  const t = tile();
  rect(t, 2, 10, 12, 4, p.trunk);
  rect(t, 2, 10, 12, 1, p.soilDark);
  for (let x = 1; x < 15; x += 2) rect(t, x, 4, 2, 5, (x / 2) % 2 < 1 ? p.accent : p.wall);
  rect(t, 1, 9, 14, 1, p.roofShade);
  speckle(t, p.crop, 3, 5);
  return t;
}

function well(p) {
  const t = tile();
  for (let a = 0; a < 40; a++)
    px(t, 8 + Math.cos((a / 40) * Math.PI * 2) * 5, 9 + Math.sin((a / 40) * Math.PI * 2) * 4, p.stoneDark);
  rect(t, 5, 7, 7, 5, p.water);
  rect(t, 6, 8, 3, 1, p.waterLight);
  rect(t, 3, 2, 1, 7, p.trunk);
  rect(t, 12, 2, 1, 7, p.trunk);
  rect(t, 3, 2, 10, 1, p.roof);
  return t;
}

function folk(p, cloak, shade, seed) {
  const t = tile();
  rect(t, 5, 14, 6, 1, "#000000", 70);
  sprite(t, 5, 2, ["..hh..", ".hssh.", "..ss..", ".cCCc.", "cCCCCc", ".cCCc.", ".l..l.", ".l..l."], {
    h: seed % 2 ? p.hair : p.trunk,
    s: p.skin,
    c: shade,
    C: cloak,
    l: p.trunk,
  });
  return t;
}

function towns(p, family) {
  const style = STYLE[family].house;
  const hall = STYLE[family].landmark === "keep" ? "flat" : STYLE[family].landmark;
  const out = {
    town_ground: [1, 2].map((seed) => ground(p, "grass", "grassLight", "grassDark", seed + 200, 0.5)),
    street: [1, 2].map((seed) => street(p, STREET[family], seed)),
    square: [street(p, STREET[family] === "dirt" ? "dirt" : "flag", 9)],
    wall: [front(p, "plain")],
    wall_window: [front(p, "window")],
    wall_door: [front(p, "door")],
    stall: [stall(p)],
    well: [well(p)],
    tree: [
      (() => {
        const t = tile();
        roundTree(t, 5, 4, p);
        return t;
      })(),
    ],
    folk: [
      folk(p, p.accent, p.roofShade, 1),
      folk(p, p.roof, p.roofShade, 2),
      folk(p, p.leaf, p.leafDark, 3),
      folk(p, p.rockLight, p.rock, 4),
    ],
  };
  for (const at of NINE) {
    out[`roof_${at}`] = [roofTile(style, at, p.roof, p.roofShade, p.wall, p.accent)];
    out[`hall_${at}`] = [roofTile(hall, at, p.stone, p.stoneDark, p.wall, p.accent)];
  }
  return out;
}

// ── Inside buildings (worldgen W13): floors, walls and furniture, in the family's palette only ──
// Drawn with the palette's own colours at full strength, so the family's pack keeps under its colour limit.

/** The floor each family lays: boards, tatami, tiles, parquet, deck plating or poured concrete. */
const FLOOR = {
  fantasy: "boards",
  wuxia: "tatami",
  modern: "tiles",
  jazz_age: "parquet",
  scifi: "plating",
  wasteland: "concrete",
};

function floor(p, kind, seed) {
  const t = tile();
  if (kind === "boards") {
    fill(t, p.soil);
    for (let y = 3; y < T; y += 4) rect(t, 0, y, T, 1, p.soilDark);
    for (let y = 0; y < T; y += 4) rect(t, ((y / 4) * 5 + seed * 3) % T, y, 1, 3, p.soilDark);
  } else if (kind === "parquet") {
    // Blocks of short boards laid crosswise in turn.
    fill(t, p.sand);
    for (let by = 0; by < T; by += 8)
      for (let bx = 0; bx < T; bx += 8) {
        const across = (bx + by) % 16 === 0;
        for (let i = 2; i < 8; i += 3)
          across ? rect(t, bx, by + i, 8, 1, p.sandDark) : rect(t, bx + i, by, 1, 8, p.sandDark);
      }
    if (seed % 2) rect(t, 0, 0, T, 1, p.sandDark);
  } else if (kind === "tatami") {
    fill(t, p.crop);
    rect(t, 0, 0, T, 1, p.cropDark);
    rect(t, 0, 0, 1, T, p.cropDark);
    for (let y = 2; y < T; y += 2) rect(t, 1, y, T - 1, 1, p.sand);
    rect(t, seed % 2 ? 7 : 0, 0, 1, T, p.cropDark);
  } else if (kind === "tiles") {
    fill(t, p.rockLight);
    rect(t, 0, 7, T, 1, p.rock);
    rect(t, 7, 0, 1, T, p.rock);
    if (seed % 2) (rect(t, 0, 0, 7, 7, p.stone), rect(t, 8, 8, 8, 8, p.stone));
  } else if (kind === "plating") {
    fill(t, p.rock);
    rect(t, 0, 0, T, 1, p.rockLight);
    rect(t, 0, 0, 1, T, p.rockLight);
    rect(t, 0, T - 1, T, 1, p.rockDark);
    rect(t, T - 1, 0, 1, T, p.rockDark);
    for (const [x, y] of [
      [2, 2],
      [13, 2],
      [2, 13],
      [13, 13],
    ])
      px(t, x, y, p.rockDark);
    if (seed % 2) rect(t, 4, 7, 8, 2, p.rockDark);
  } else {
    fill(t, p.stone);
    speckle(t, p.stoneDark, 7, seed + 40);
    speckle(t, p.rockLight, 4, seed + 41);
  }
  return t;
}

/** A wall seen from above inside: its top, and its face where the room is below it. */
function innerWall(p) {
  const t = tile();
  fill(t, p.wallShade);
  rect(t, 0, 0, T, 3, p.wall);
  rect(t, 0, T - 2, T, 2, p.stoneDark);
  return t;
}

function doorway(p, kind) {
  const t = floor(p, kind, 1);
  rect(t, 2, 0, 12, 2, p.door);
  rect(t, 2, T - 2, 12, 2, p.door);
  return t;
}

function furniture(p, kind, family) {
  const t = tile();
  if (family === "wuxia" && (kind === "bench" || kind === "bed")) {
    // Floor mats to kneel on, and a sleeping mat rolled out on the floor.
    const [y, h] = kind === "bench" ? [4, 8] : [1, 14];
    rect(t, 1, y, 14, h, p.cropDark);
    rect(t, 2, y + 1, 12, h - 2, p.crop);
    if (kind === "bed") (rect(t, 3, 2, 10, 3, p.wall), rect(t, 2, 6, 12, 8, p.cloak));
    return t;
  }
  const wood = p.trunk;
  const dark = p.door;
  switch (kind) {
    case "bed":
      rect(t, 2, 1, 12, 14, dark);
      rect(t, 3, 2, 10, 4, p.wall);
      rect(t, 3, 6, 10, 8, p.cloak);
      rect(t, 3, 12, 10, 2, p.cloakShade);
      break;
    case "table":
      rect(t, 2, 4, 12, 7, wood);
      rect(t, 2, 4, 12, 1, p.soil);
      rect(t, 2, 11, 12, 1, dark);
      rect(t, 3, 12, 1, 3, dark);
      rect(t, 12, 12, 1, 3, dark);
      break;
    case "chair":
      rect(t, 5, 3, 6, 2, dark);
      rect(t, 5, 7, 6, 4, wood);
      rect(t, 5, 11, 1, 3, dark);
      rect(t, 10, 11, 1, 3, dark);
      break;
    case "counter":
      rect(t, 0, 4, T, 9, wood);
      rect(t, 0, 4, T, 2, p.soil);
      rect(t, 0, 13, T, 1, dark);
      break;
    case "shelf":
      rect(t, 1, 0, 14, 15, dark);
      for (const y of [2, 7, 12]) rect(t, 2, y, 12, 1, wood);
      for (const [x, y, c] of [
        [3, 0, p.accent],
        [6, 5, p.roof],
        [9, 0, p.cloak],
        [11, 5, p.crop],
        [4, 10, p.leaf],
        [10, 10, p.wall],
      ])
        rect(t, x, y + 0, 2, 2, c);
      break;
    case "hearth":
      rect(t, 1, 1, 14, 14, p.stoneDark);
      rect(t, 3, 5, 10, 9, "#000000");
      rect(t, 5, 9, 6, 4, p.roof);
      rect(t, 6, 10, 4, 2, p.accent);
      rect(t, 1, 1, 14, 2, p.stone);
      break;
    case "crate":
      rect(t, 3, 4, 10, 10, wood);
      rect(t, 3, 4, 10, 1, p.soil);
      rect(t, 3, 13, 10, 1, dark);
      for (let i = 0; i < 9; i++) px(t, 4 + i, 5 + i, dark);
      break;
    case "barrel":
      rect(t, 4, 2, 8, 12, wood);
      rect(t, 3, 4, 10, 8, wood);
      rect(t, 3, 5, 10, 1, p.stoneDark);
      rect(t, 3, 10, 10, 1, p.stoneDark);
      rect(t, 5, 2, 6, 1, p.soil);
      break;
    case "altar":
      rect(t, 1, 6, 14, 8, p.stone);
      rect(t, 1, 6, 14, 2, p.rockLight);
      rect(t, 1, 13, 14, 1, p.stoneDark);
      // Two candles and an offering bowl: no one faith's sign.
      for (const x of [2, 12]) (rect(t, x, 3, 2, 3, p.wall), px(t, x, 2, p.accent), px(t, x + 1, 1, p.roof));
      rect(t, 6, 4, 4, 2, p.stoneDark);
      rect(t, 7, 3, 2, 1, p.crop);
      break;
    case "bench":
      rect(t, 0, 6, T, 4, wood);
      rect(t, 0, 6, T, 1, p.soil);
      rect(t, 1, 10, 1, 3, dark);
      rect(t, 14, 10, 1, 3, dark);
      break;
    case "workbench":
      rect(t, 1, 5, 14, 6, wood);
      rect(t, 1, 5, 14, 1, p.soil);
      rect(t, 2, 11, 1, 4, dark);
      rect(t, 13, 11, 1, 4, dark);
      rect(t, 4, 3, 3, 2, p.stoneDark);
      rect(t, 9, 4, 4, 1, p.rockLight);
      break;
    case "furnace":
      rect(t, 2, 1, 12, 14, p.stoneDark);
      rect(t, 2, 1, 12, 2, p.stone);
      rect(t, 4, 7, 8, 6, "#000000");
      rect(t, 5, 9, 6, 3, p.roof);
      rect(t, 7, 10, 2, 1, p.accent);
      break;
    case "desk":
      rect(t, 1, 4, 14, 7, wood);
      rect(t, 1, 4, 14, 1, p.soil);
      rect(t, 2, 11, 1, 4, dark);
      rect(t, 13, 11, 1, 4, dark);
      rect(t, 4, 5, 5, 4, p.wall);
      rect(t, 11, 5, 1, 4, p.cloak);
      break;
    case "bookshelf":
      rect(t, 1, 0, 14, 15, dark);
      for (const y of [1, 6, 11]) {
        let x = 2;
        for (const c of [p.roof, p.cloak, p.leaf, p.accent, p.roofShade, p.cloakShade]) {
          rect(t, x, y, 2, 4, c);
          x += 2;
        }
      }
      break;
    case "rack":
      rect(t, 1, 2, 14, 1, dark);
      rect(t, 1, 12, 14, 1, dark);
      for (const x of [3, 7, 11]) (rect(t, x, 1, 1, 12, p.rockLight), rect(t, x - 1, 1, 3, 1, p.stoneDark));
      break;
    case "rug":
      rect(t, 1, 3, 14, 10, p.roof);
      rect(t, 2, 4, 12, 8, p.roofShade);
      rect(t, 4, 6, 8, 4, p.accent);
      break;
    case "plant":
      rect(t, 5, 10, 6, 5, p.roofShade);
      rect(t, 5, 10, 6, 1, p.roof);
      rect(t, 4, 3, 8, 7, p.leaf);
      rect(t, 6, 2, 4, 3, p.leafLight);
      speckle(t, p.leafDark, 4, 9);
      break;
    case "lamp":
      rect(t, 7, 6, 2, 8, dark);
      rect(t, 5, 13, 6, 2, dark);
      rect(t, 5, 2, 6, 5, p.accent);
      rect(t, 6, 3, 4, 3, p.wall);
      break;
  }
  return t;
}

const FURNITURE_KINDS = [
  "bed",
  "table",
  "chair",
  "counter",
  "shelf",
  "hearth",
  "crate",
  "barrel",
  "altar",
  "bench",
  "workbench",
  "furnace",
  "desk",
  "bookshelf",
  "rack",
  "rug",
  "plant",
  "lamp",
];

function interiors(p, family) {
  const out = {
    in_floor: [1, 2].map((seed) => floor(p, FLOOR[family], seed)),
    in_wall: [innerWall(p)],
    in_door: [doorway(p, FLOOR[family])],
  };
  for (const kind of FURNITURE_KINDS) out[`in_${kind}`] = [furniture(p, kind, family)];
  return out;
}

// ── Packs: each family's tiles as data, a palette and rows of characters (the shared tile-pack format) ──

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NAMES = {
  fantasy: "Fantasy",
  wuxia: "Wuxia",
  modern: "Modern day",
  jazz_age: "The 1920s",
  scifi: "Science fiction",
  wasteland: "Wasteland",
};
const hex2 = (value) => Math.round(value).toString(16).padStart(2, "0");

const outDir = join(ROOT, "packages/server/src/assets/overworld-tiles");
mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [family, p] of Object.entries(PALETTES)) {
  const palette = [];
  const index = new Map();
  const rowsOf = (image) => {
    const rows = [];
    for (let y = 0; y < T; y++) {
      let line = "";
      for (let x = 0; x < T; x++) {
        const at = (y * T + x) * 4;
        const alpha = image[at + 3];
        if (alpha === 0) {
          line += ".";
          continue;
        }
        const colour = `#${hex2(image[at])}${hex2(image[at + 1])}${hex2(image[at + 2])}${alpha < 255 ? hex2(alpha) : ""}`;
        if (!index.has(colour)) {
          if (palette.length >= ALPHABET.length) throw new Error(`${family}: more than ${ALPHABET.length} colours`);
          index.set(colour, palette.length);
          palette.push(colour);
        }
        line += ALPHABET[index.get(colour)];
      }
      rows.push(line);
    }
    return rows;
  };
  const tiles = {};
  const add = (id, images) => {
    tiles[id] = images.map(rowsOf);
  };
  for (const [look, images] of Object.entries(grounds(p))) add(look, images);
  const { tiers, ruin } = markers(p, STYLE[family]);
  tiers.forEach((image, tier) => add(`marker${tier}`, [image]));
  add("ruin", [ruin]);
  add("party", [party(p)]);
  for (const [id, images] of Object.entries(towns(p, family))) add(id, images);
  for (const [id, images] of Object.entries(interiors(p, family))) add(id, images);
  const pack = { tilePackVersion: 1, id: family, name: NAMES[family], family, version: 1, palette, tiles };
  writeFileSync(join(outDir, `${family}.json`), `${JSON.stringify(pack)}\n`);
  written++;
}
console.log(`Overworld tiles: ${written} family packs written.`);
