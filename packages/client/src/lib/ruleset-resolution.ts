// How a ruleset's own numbers read on screen.
//
// One module, because the same ruleset must never be spelled two ways: the sheet editor, the
// in-game sheet, the import review and the setup wizard all ask here. Nothing is shaped around one
// game system; every number comes out of the definition the file declared.
import { formatRulesetCheckValue, type RulesetDefinition } from "@marinara-engine/shared";
import type { TFunction } from "i18next";

/**
 * One check number, spelled the way its resolution kind means it: a modifier added to the dice
 * ("+5"), or how many dice are thrown ("5 dice").
 *
 * The summed kind goes through the shared formatter, so a `dice-sum` ruleset shows exactly the
 * bytes it always has. A pool is worded here instead, because the shared helper also writes the
 * Game Master's prompt and therefore has to stay in English.
 */
export function rulesetCheckValueText(definition: RulesetDefinition, value: number, t: TFunction): string {
  const kind = definition.resolution.kind;
  if (kind !== "dice-sum" && kind !== "roll-against" && kind !== "symbol-pool")
    return t("game.ruleset.check.dice", { count: value });
  return formatRulesetCheckValue(definition, value);
}

/**
 * Plain sentences saying how this ruleset rolls a check: a headline, then one line per optional
 * rule the file turned on. A ruleset that turns none on is one line, exactly as before.
 */
export function rulesetRulesSummary(definition: RulesetDefinition, t: TFunction): string[] {
  const resolution = definition.resolution;
  if (resolution.kind === "dice-sum") {
    return [t("game.ruleset.import.resolutionDiceSum", { dice: `${resolution.dice.count}d${resolution.dice.sides}` })];
  }
  if (resolution.kind === "symbol-pool") {
    return [
      t(resolution.pool.build === "sum" ? "game.ruleset.rules.symbolSum" : "game.ruleset.rules.symbolPool"),
      t("game.ruleset.rules.symbolSuccess", {
        needed: resolution.success.needed,
        symbol: resolution.symbols.find((symbol) => symbol.id === resolution.success.symbol)?.label,
      }),
      t("game.ruleset.rules.symbolDifficulty", { max: resolution.difficulty.max }),
    ];
  }
  if (resolution.kind === "roll-against") {
    // Against the sheet's number (1.139): which way, on what dice, and what changes the number.
    const dice = `${resolution.dice.count}d${resolution.dice.sides}`;
    const lines = [
      t(resolution.against === "at-most" ? "game.ruleset.rules.againstAtMost" : "game.ruleset.rules.againstAtLeast", {
        dice,
      }),
    ];
    if (resolution.difficultyLadder.some((step) => "divide" in step && step.divide)) {
      lines.push(t("game.ruleset.rules.againstDivide"));
    }
    if (resolution.criticalSuccess || resolution.criticalFailure) lines.push(t("game.ruleset.rules.againstCriticals"));
    if (resolution.tens) lines.push(t("game.ruleset.rules.againstTens", { max: resolution.tens.max }));
    return lines;
  }
  if (resolution.kind === "dice-highest") {
    // Keep the highest (1.138): one line for the read, then each rule the file turned on.
    const sides = resolution.die.sides;
    const lines = [
      resolution.keep === 1
        ? t("game.ruleset.rules.highest", { sides })
        : t("game.ruleset.rules.highestKeep", { sides, keep: resolution.keep }),
      t(resolution.zeroDice === "fail" ? "game.ruleset.rules.zeroFail" : "game.ruleset.rules.zeroLowest"),
    ];
    if (resolution.critical) {
      lines.push(
        t("game.ruleset.rules.highestCritical", {
          count: resolution.critical.count,
          face: resolution.critical.face ?? sides,
        }),
      );
    }
    if (resolution.dark) {
      lines.push(t("game.ruleset.rules.dark", { max: resolution.dark.max, label: resolution.dark.label }));
    }
    if (resolution.situationalDice) {
      lines.push(
        t("game.ruleset.rules.situational", {
          min: resolution.situationalDice.min,
          max: resolution.situationalDice.max,
        }),
      );
    }
    return lines;
  }
  const sides = resolution.die.sides;
  const lines: string[] = [
    // A target the Game Master may move is reported as the range it may move in, so nobody reads
    // the default as a fixed rule.
    resolution.target.min < resolution.target.max
      ? t("game.ruleset.rules.poolTargetRange", { sides, min: resolution.target.min, max: resolution.target.max })
      : t("game.ruleset.rules.poolTarget", { sides, target: resolution.target.default }),
  ];
  // A face rule a check may move says how far; one with only a `min` fires only when a check asks.
  for (const key of ["double", "explode"] as const) {
    const rule = resolution[key];
    if (!rule) continue;
    if (rule.from === undefined) lines.push(t(`game.ruleset.rules.${key}OnAsk`, { min: rule.min }));
    else if (rule.min === undefined) lines.push(t(`game.ruleset.rules.${key}`, { from: rule.from }));
    else lines.push(t(`game.ruleset.rules.${key}Movable`, { from: rule.from, min: rule.min }));
  }
  if (resolution.cancel) lines.push(t("game.ruleset.rules.cancel", { upTo: resolution.cancel.upTo }));
  if (resolution.botch) {
    lines.push(
      t(resolution.botch.rule === "halfOrMore" ? "game.ruleset.rules.botchHalf" : "game.ruleset.rules.botch", {
        upTo: resolution.botch.upTo,
      }),
    );
  }
  if (resolution.exceptional) {
    lines.push(t("game.ruleset.rules.exceptional", { count: resolution.exceptional.successes }));
  }
  if (resolution.situationalDice) {
    lines.push(
      t("game.ruleset.rules.situational", {
        min: resolution.situationalDice.min,
        max: resolution.situationalDice.max,
      }),
    );
  }
  for (const reroll of resolution.reroll ?? []) {
    lines.push(
      t(reroll.mode === "until" ? "game.ruleset.rules.rerollUntil" : "game.ruleset.rules.reroll", {
        id: reroll.id,
        upTo: reroll.upTo,
      }),
    );
  }
  // About what fills the pool rather than what its dice do, so it comes after every dice rule.
  if (resolution.pool.abilityPlusAbility) lines.push(t("game.ruleset.rules.abilityPlusAbility"));
  return lines;
}
