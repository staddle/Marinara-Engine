// ──────────────────────────────────────────────
// Image tile packs (Pixelforge image tiles, tile pack v2): every sheet checked for real before a pack is
// kept. The shared reader has already checked each sheet's PNG structure (signature, header, every
// chunk's CRC) and size without decoding it; where sharp is available the server also reads the header
// with a pixel limit and re-encodes the sheet, keeping its transparency, so what is stored is a clean
// PNG the Engine wrote. Without sharp (some Android installs) the structural check is the check.
// ──────────────────────────────────────────────
import { TILE_PACK_IMAGE_MAX_BYTES, TILE_PACK_IMAGE_SHEET_PX, type ImageTilePack } from "@marinara-engine/shared";
import { getSharp } from "../image/sharp-runtime.js";

const PNG_DATA_URL = "data:image/png;base64,";

export type CleanedTilePack = { ok: true; pack: ImageTilePack } | { ok: false; issue: string };

export async function cleanImageTilePack(pack: ImageTilePack): Promise<CleanedTilePack> {
  let sharp: Awaited<ReturnType<typeof getSharp>> | null = null;
  try {
    sharp = await getSharp();
  } catch {
    return { ok: true, pack };
  }
  const sheets: ImageTilePack["sheets"] = [];
  for (const sheet of pack.sheets) {
    const input = Buffer.from(sheet.png.slice(PNG_DATA_URL.length), "base64");
    try {
      const options = { limitInputPixels: TILE_PACK_IMAGE_SHEET_PX * TILE_PACK_IMAGE_SHEET_PX, failOn: "error" };
      const meta = await sharp(input, options).metadata();
      if (meta.format !== "png" || meta.width !== sheet.width || meta.height !== sheet.height) {
        return { ok: false, issue: `The sheet "${sheet.id}" is not the PNG it says it is.` };
      }
      const output: Buffer = await sharp(input, options).ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
      sheets.push({ ...sheet, png: `${PNG_DATA_URL}${output.toString("base64")}` });
    } catch {
      return { ok: false, issue: `The sheet "${sheet.id}" does not decode.` };
    }
  }
  const cleaned = { ...pack, sheets };
  // Written again, a sheet can come out larger than it went in.
  if (sheets.reduce((sum, sheet) => sum + sheet.png.length, 0) > TILE_PACK_IMAGE_MAX_BYTES) {
    return { ok: false, issue: "The sheets come out larger than a tile pack can be; make them smaller." };
  }
  return { ok: true, pack: cleaned };
}
