/**
 * The setup wizard's setting and goal ideas (worldgen W6g): from across the starter settings, a new mix
 * at each opening, led by the picked setting kit's own; every idea is an English key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WORLD_STARTER_KITS } from "../../packages/shared/src/index.js";
import {
  SETTING_GENRE,
  SUGGESTION_SETTINGS,
  allSetupSuggestionKeys,
  setupSuggestionKeys,
} from "../../packages/client/src/lib/game-setup-suggestions.js";

const english = JSON.parse(
  readFileSync(new URL("../../packages/client/src/localization/locales/en.json", import.meta.url), "utf8"),
) as Record<string, string>;
const settingOf = (key: string) => key.split(".")[3];

// Every starter setting has ideas and a genre, so a new starter kit cannot be left out.
assert.deepEqual([...SUGGESTION_SETTINGS].sort(), WORLD_STARTER_KITS.map((kit) => kit.id).sort());
for (const kit of SUGGESTION_SETTINGS) assert.ok(SETTING_GENRE[kit], kit);
for (const kind of ["setting", "goal"] as const) {
  const all = allSetupSuggestionKeys(kind);
  assert.equal(all.length, SUGGESTION_SETTINGS.length * 2);
  for (const key of all) assert.ok(english[key], `${key} has English words`);

  const seen = new Set<string>();
  for (let offset = 0; offset < SUGGESTION_SETTINGS.length * 2; offset++) {
    // Without a kit: three ideas from three different settings.
    const plain = setupSuggestionKeys(kind, null, offset);
    assert.equal(plain.length, 3);
    assert.equal(new Set(plain.map(settingOf)).size, 3, `offset ${offset}`);
    for (const key of plain) seen.add(key);
    // With a starter kit: its own two first, then one from another setting.
    for (const kit of SUGGESTION_SETTINGS) {
      const led = setupSuggestionKeys(kind, kit, offset);
      assert.deepEqual(led.slice(0, 2), [
        `game.setup.suggestions.${kit}.${kind}1`,
        `game.setup.suggestions.${kit}.${kind}2`,
      ]);
      assert.notEqual(settingOf(led[2]!), kit);
    }
    // A written kit (no starter of its own) gets the plain rotation.
    assert.deepEqual(setupSuggestionKeys(kind, "written", offset), plain);
  }
  // The rotation reaches every idea.
  assert.equal(seen.size, all.length, `every ${kind} idea is offered at some opening`);
}

console.log("Setup suggestions: ideas from every starter setting, rotated, led by the picked kit.");
