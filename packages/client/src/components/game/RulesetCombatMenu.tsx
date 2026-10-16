// The menu of a fight the ruleset resolves: what the actor on turn may do, who they may do it to,
// and which pool pays for it.
//
// Every option on screen came off the server's own legal menu, with its own label, its own costs,
// its own forecast and the exact ids it may be pointed at. Nothing here works out whether something
// is allowed, what it would cost or how likely it is to land: an option the rules do not allow is
// simply not sent, so nothing is ever greyed out by this file.
//
// On a board, a step that picks a cell (walking, or aiming a shape) is drawn by the board rather
// than listed here, so the half-made choice is HELD by the board and handed back down: one step,
// two ways of finishing it, and the same pure rules behind both.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { RULESET_CHARGE_STEP_PREFIX, RULESET_PASS_OPTION } from "@marinara-engine/shared";
import type { DirectedRulesetOption, DirectedRulesetView } from "@marinara-engine/shared";
import { ArtIcon } from "./ArtIcon";
import { useTranslation } from "react-i18next";
import {
  rulesetAimSoFar,
  rulesetAimTurning,
  type RulesetCellChoice,
  rulesetOptionHasAim,
  rulesetOptionNeedsAim,
  rulesetOptionNeedsCell,
} from "../../lib/ruleset-combat-board";
import {
  rulesetDefaultTargets,
  rulesetPicksStep,
  rulesetMenuGroups,
  rulesetOptionCostText,
  rulesetModeText,
  rulesetOptionForecastText,
  rulesetOptionLabel,
  rulesetOptionNeedsTargets,
  rulesetPickTarget,
  rulesetSendsOnPick,
  rulesetStyleForecastText,
  type RulesetMenuStep,
} from "../../lib/ruleset-combat-menu";
import { cn } from "../../lib/utils";

export interface RulesetCombatMenuProps {
  view: DirectedRulesetView;
  /** The ruleset's own name for a budget id, so the menu says "Bonus action" or "Action" as the
   *  file does, never a word this Engine picked. */
  budgetLabel: (id: string) => string;
  /** What the ruleset calls the number an attack is rolled against ("Armor Class", "Guard"), so a
   *  held hit reads as the log does. Empty when the ruleset names none. */
  defenseLabel?: string;
  busy: boolean;
  onChoose: (
    optionId: string,
    targetIds: string[],
    payWith?: string,
    /** Where a walk goes, and where a shape is aimed. Only a positioned fight ever sends one. */
    cell?: RulesetCellChoice,
    /** The initiative style an attack is made in, where initiative is a number attacks move. */
    style?: string,
    /** The weapon's mode an attack is made in. */
    mode?: string,
    /** How many uses it spends, where the option lets its user choose (1.251). */
    amount?: number,
    /** The alterations it is used with (1.253): Metamagic. */
    alters?: string[],
    /** Who of its user's side they spare (1.254): Careful Spell. */
    spares?: string[],
    /** Who they give disadvantage on their first save (1.255): Heightened Spell. */
    heightens?: string,
  ) => void;
  /** Walking away. The ruleset's menu never carries it, because leaving is not a thing the rules
   *  resolve: it is the director ending the session, exactly as the other two styles end it. */
  onFlee: () => void;
  /** The half-made choice, when a board is holding it. Without both of these the menu keeps its
   *  own, which is what the fight with no board does. */
  step?: RulesetMenuStep | null;
  onStepChange?: (step: RulesetMenuStep | null) => void;
  /** The board's handle on this menu, so Escape from a cell can put the keyboard back here. */
  menuRef?: RefObject<HTMLDivElement | null>;
}

const buttonClass =
  "min-h-11 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)] disabled:opacity-50";

/** Which question the window is asking, by what opened it. A moment a reaction waits for names
 *  itself; the other two are the kind of window they are. */
const WINDOW_PROMPTS = {
  aimed: "Aimed",
  hit: "Hit",
  harmed: "Harmed",
  falls: "Falls",
  "turn-start": "TurnStart",
  used: "Used",
  signature: "Between",
  reaction: "Leaving",
} as const;

export function RulesetCombatMenu({
  view,
  budgetLabel,
  defenseLabel,
  busy,
  onChoose,
  onFlee,
  step: heldStep,
  onStepChange,
  menuRef,
}: RulesetCombatMenuProps) {
  const { t } = useTranslation();
  const [ownStep, setOwnStep] = useState<RulesetMenuStep | null>(null);
  // The number typed into the amount step (1.251), kept as text so a cleared box is not a zero.
  const [amountText, setAmountText] = useState("");
  // The alterations ticked in the alter step (1.253).
  const [altersPicked, setAltersPicked] = useState<string[]>([]);
  // Who of its user's side is ticked to be spared in the spare step (1.254).
  const [sparesPicked, setSparesPicked] = useState<string[]>([]);
  // Held by the owner only when it passes BOTH halves (`step` may be null, never left out): with one
  // of them missing the menu keeps its own, or a pick would be handed up and never come back down.
  const held = onStepChange !== undefined && heldStep !== undefined;
  const step = held ? heldStep : ownStep;
  // Opened here or on the board, the spare step starts with as many ticked as it spares, in order.
  const spareOpen = step?.stage === "spare" ? step.spare : undefined;
  useEffect(() => {
    if (spareOpen) setSparesPicked(spareOpen.ids.slice(0, spareOpen.most));
  }, [spareOpen]);
  // Stable whatever the owner passes, so the turn reset below runs when the turn moves and never
  // because a parent handed down a fresh function.
  const stepChange = useRef(held ? onStepChange : undefined);
  stepChange.current = held ? onStepChange : undefined;
  const setStep = useCallback((next: RulesetMenuStep | null) => {
    if (stepChange.current) stepChange.current(next);
    else setOwnStep(next);
  }, []);
  const first = useRef<HTMLButtonElement>(null);
  const ownRoot = useRef<HTMLDivElement>(null);
  const root = menuRef ?? ownRoot;
  const distance = view.grid?.distance;
  const nameOf = (id: string | undefined) => view.combatants.find((combatant) => combatant.id === id)?.name ?? "";
  const actorName = nameOf(view.actorId);
  // While a window holds the fight open the menu below is the ASKED combatant's, not the actor's,
  // so everything that says whose menu this is says theirs.
  const askedName = view.window ? nameOf(view.window.actorId) : actorName;
  const groups = useMemo(() => rulesetMenuGroups(view.options), [view.options]);
  // A fresh menu is a fresh choice: the turn moved on, so a half-finished pick from the last one
  // must never be sent against it.
  useEffect(() => {
    setStep(null);
  }, [view.actorId, view.round, view.window?.id, setStep]);
  // Focus follows a NEW stage or a new option, never every pick: choosing the second of three
  // targets replaces `step`, and pulling focus back to the first button each time would take the
  // keyboard away from somebody working down the list.
  const stepStage = step?.stage;
  const stepOption = step?.option.id;
  // Set by the player's own way out of a step (Back, or a choice that was sent), never by the turn
  // moving on underneath an open step.
  const playerClosedStep = useRef(false);
  const closeStep = () => {
    // Only when there IS a step to leave: a choice sent straight off the menu closes nothing, and a
    // flag left standing would be spent on the next turn reset instead.
    playerClosedStep.current = step !== null;
    setStep(null);
  };
  useEffect(() => {
    // A step the BOARD draws has its keyboard on the board, so the menu must not take it back the
    // moment the stage opens.
    if (
      stepStage === "style" ||
      stepStage === "mode" ||
      stepStage === "alter" ||
      stepStage === "spare" ||
      stepStage === "heighten" ||
      stepStage === "pay" ||
      stepStage === "amount" ||
      stepStage === "target"
    ) {
      first.current?.focus();
    }
    // Going BACK unmounts the step, and the browser would drop focus on the body, leaving a keyboard
    // player to Tab down from the top of the page. The menu takes it instead, and only then: a
    // menu that appears, or is reset because the turn moved on, must not steal focus from wherever
    // the player is.
    else if (!stepStage && playerClosedStep.current) root.current?.focus();
    playerClosedStep.current = false;
  }, [stepStage, stepOption, root]);

  if (!view.options) {
    return (
      <p className="px-3 py-2 text-xs text-white/55" role="status">
        {actorName
          ? t("game.combat.ruleset.menu.waiting", { name: actorName })
          : t("game.combat.ruleset.menu.waitingAnybody")}
      </p>
    );
  }

  const send = (
    option: DirectedRulesetOption,
    targets: string[],
    payWith?: string,
    style?: string,
    mode?: string,
    // A step that went through the amount carries it; one sent straight off the menu passes its own.
    amount: number | undefined = step?.amount,
    alters: string[] | undefined = step?.alters,
  ) => {
    if (picksFirst({ stage: "target", option, targets, payWith, style, mode, amount, alters })) return;
    closeStep();
    onChoose(option.id, targets, payWith, undefined, style, mode, amount, alters);
  };
  /** Who it spares and who it heightens are picked before it is sent, where there is a pick to make
   *  (1.254, 1.255). True when that step was opened. */
  const picksFirst = (held: RulesetMenuStep): boolean => {
    const next = rulesetPicksStep(view, held, held.targets, held.cell);
    if (!next) return false;
    setStep(next);
    return true;
  };
  /** Sent with what was picked for it. */
  const sendPicked = (held: RulesetMenuStep, heightens?: string) => {
    closeStep();
    onChoose(
      held.option.id,
      held.targets,
      held.payWith,
      held.cell,
      held.style,
      held.mode,
      held.amount,
      held.alters,
      held.spared,
      heightens,
    );
  };
  /** Which picking step this option opens, or null for one that is simply sent. On a board, a walk
   *  and a shape are picked on the board; everything else is the list below. */
  const stageFor = (option: DirectedRulesetOption): RulesetMenuStep["stage"] | null => {
    if (view.grid && rulesetOptionNeedsCell(option)) return "move";
    if (view.grid && rulesetOptionNeedsAim(option)) return "aim";
    return rulesetOptionNeedsTargets(option) ? "target" : null;
  };
  /** The step after the style and the mode are chosen: what pays for it, where it goes, or who it is
   *  aimed at, as many as the mode aims at. */
  const afterMode = (
    option: DirectedRulesetOption,
    style?: string,
    mode?: string,
    amount?: number | null,
    /** null once the alter step was passed with none ticked (1.253). */
    alters?: string[] | null,
  ) => {
    const how = {
      ...(style ? { style } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof amount === "number" ? { amount } : {}),
      ...(alters?.length ? { alters } : {}),
    };
    // What it may be used with comes first (1.253): Metamagic, which may give it another target.
    if (option.alters?.length && alters === undefined) {
      setAltersPicked(option.alterNeeded ? [option.alterNeeded] : []);
      setStep({ stage: "alter", option, ...how, targets: [] });
      return;
    }
    const chosen = mode ? option.modes?.find((entry) => entry.id === mode) : undefined;
    const moded = chosen ? { ...option, targets: { ...option.targets, count: chosen.targets } } : option;
    const twins = (alters ?? []).filter((id) => option.alters?.find((offer) => offer.id === id)?.twins).length;
    const aimed = twins ? { ...moded, targets: { ...moded.targets, count: moded.targets.count + twins } } : moded;
    // How much of it to spend comes first where its user chooses (1.251); null is "just enough",
    // which the rules work out from the target.
    if (aimed.amount && amount === undefined) {
      setAmountText(String(aimed.amount.max));
      // The option as it came, so going on from here aims it once, not twice.
      setStep({ stage: "amount", option, ...how, targets: [] });
      return;
    }
    if (aimed.payWith && aimed.payWith.length > 0) {
      setStep({ stage: "pay", option: aimed, ...how, targets: [] });
      return;
    }
    const stage = stageFor(aimed);
    if (stage) {
      setStep({
        stage,
        option: aimed,
        ...how,
        targets: view.window?.moment === "falls" ? aimed.targetIds.slice(0, aimed.targets.count) : [],
      });
      return;
    }
    send(aimed, rulesetDefaultTargets(aimed), undefined, style, mode, how.amount, how.alters);
  };
  /** The step after the style is chosen: the weapon's mode, where it has any. */
  const afterStyle = (option: DirectedRulesetOption, style?: string) => {
    if (option.modes && option.modes.length > 0) {
      setStep({ stage: "mode", option, ...(style ? { style } : {}), targets: [] });
      return;
    }
    afterMode(option, style);
  };
  const take = (option: DirectedRulesetOption) => {
    // Where attacks move initiative, how the attack is made comes first: it decides what it does.
    if (option.styles && option.styles.length > 0) {
      setStep({ stage: "style", option, targets: [] });
      return;
    }
    afterStyle(option);
  };
  const paid = (payWith?: string) => {
    if (!step) return;
    // A pool that lets it take more targets aims at as many as it lets it (1.171).
    const count = payWith ? step.option.targetsWith?.[payWith] : undefined;
    const option = count !== undefined ? { ...step.option, targets: { ...step.option.targets, count } } : step.option;
    const stage = stageFor(option);
    if (!stage) {
      send(option, rulesetDefaultTargets(option), payWith, step.style, step.mode);
      return;
    }
    setStep({
      ...step,
      option,
      stage,
      ...(payWith ? { payWith } : {}),
      targets: view.window?.moment === "falls" ? option.targetIds.slice(0, option.targets.count) : [],
    });
  };
  const pick = (id: string) => {
    if (!step) return;
    const targets = rulesetPickTarget(step.option, step.targets, id);
    if (rulesetSendsOnPick(step.option) && targets.length === 1) {
      send(step.option, targets, step.payWith, step.style, step.mode);
      return;
    }
    setStep({ ...step, targets });
  };

  // ── Making an attack in one of the ruleset's initiative styles ──
  const styles = step?.stage === "style" ? (step.option.styles ?? []) : [];
  if (step && styles.length > 0) {
    const option = step.option;
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60" id="ruleset-style-prompt">
          {t("game.combat.ruleset.style.prompt", { label: rulesetOptionLabel(option, t) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-style-prompt">
          {styles.map((style, index) => {
            const forecast = rulesetStyleForecastText(style, t);
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={style.id}
                type="button"
                disabled={busy}
                onClick={() => afterStyle(option, style.id)}
                className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
              >
                <span className="block font-semibold text-white/90">{style.label}</span>
                {forecast && <span className="block text-[0.65rem] text-white/45">{forecast}</span>}
              </button>
            );
          })}
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Using a weapon in one of its modes ──
  const modes = step?.stage === "mode" ? (step.option.modes ?? []) : [];
  if (step && modes.length > 0) {
    const option = step.option;
    const plain = rulesetOptionForecastText(option, t);
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60" id="ruleset-mode-prompt">
          {t("game.combat.ruleset.mode.prompt", { label: rulesetOptionLabel(option, t) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-mode-prompt">
          <button
            ref={first}
            type="button"
            disabled={busy}
            onClick={() => afterMode(option, step.style)}
            className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
          >
            <span className="block font-semibold text-white/90">{t("game.combat.ruleset.mode.plain")}</span>
            {plain && <span className="block text-[0.65rem] text-white/45">{plain}</span>}
          </button>
          {modes.map((mode) => {
            const forecast = rulesetModeText(option, mode, t);
            return (
              <button
                key={mode.id}
                type="button"
                disabled={busy}
                onClick={() => afterMode(option, step.style, mode.id)}
                className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
              >
                <span className="block font-semibold text-white/90">{mode.label}</span>
                {forecast && <span className="block text-[0.65rem] text-white/45">{forecast}</span>}
              </button>
            );
          })}
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Choosing what to use it with (1.253) ──
  if (step?.stage === "alter" && step.option.alters?.length) {
    const option = step.option;
    const offers = option.alters!;
    const toggle = (id: string) => {
      if (id === option.alterNeeded) return;
      const offer = offers.find((one) => one.id === id);
      if (altersPicked.includes(id)) {
        setAltersPicked(altersPicked.filter((one) => one !== id));
        return;
      }
      // Only one that does not join another (Empowered joins one).
      const kept = offer?.joins
        ? altersPicked
        : altersPicked.filter((one) => offers.find((entry) => entry.id === one)?.joins || one === option.alterNeeded);
      setAltersPicked(
        offer?.joins || !kept.some((one) => !offers.find((entry) => entry.id === one)?.joins) ? [...kept, id] : kept,
      );
    };
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60" id="ruleset-alter-prompt">
          {t("game.combat.ruleset.alter.prompt", { label: rulesetOptionLabel(option, t) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-alter-prompt">
          {offers.map((offer, index) => {
            const picked = altersPicked.includes(offer.id);
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={offer.id}
                type="button"
                disabled={busy || offer.id === option.alterNeeded}
                aria-pressed={picked}
                onClick={() => toggle(offer.id)}
                className={cn(
                  buttonClass,
                  picked
                    ? "border-[var(--primary)]/60 bg-[var(--primary)]/25 text-white"
                    : "border-white/15 bg-white/5 text-white/85 hover:bg-white/10",
                )}
              >
                <span className="block font-semibold">{offer.label}</span>
                <span className="block text-[0.65rem] text-white/55">
                  {t(offer.perLevel ? "game.combat.ruleset.alter.costPerLevel" : "game.combat.ruleset.alter.cost", {
                    count: offer.cost,
                  })}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              afterMode(option, step.style, step.mode, undefined, altersPicked.length ? altersPicked : null)
            }
            className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
          >
            {altersPicked.length
              ? t("game.combat.ruleset.alter.use", { count: altersPicked.length })
              : t("game.combat.ruleset.alter.none")}
          </button>
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Who of its user's side it spares (1.254): Careful Spell ──
  if (step?.stage === "spare" && step.spare) {
    const { ids, most } = step.spare;
    const toggle = (id: string) =>
      setSparesPicked(
        sparesPicked.includes(id)
          ? sparesPicked.filter((one) => one !== id)
          : sparesPicked.length < most
            ? [...sparesPicked, id]
            : sparesPicked,
      );
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60" id="ruleset-spare-prompt">
          {t("game.combat.ruleset.spare.prompt", { label: rulesetOptionLabel(step.option, t), count: most })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-spare-prompt">
          {ids.map((id, index) => {
            const picked = sparesPicked.includes(id);
            const combatant = view.combatants.find((one) => one.id === id);
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={id}
                type="button"
                disabled={busy || (!picked && sparesPicked.length >= most)}
                aria-pressed={picked}
                onClick={() => toggle(id)}
                className={cn(
                  buttonClass,
                  picked
                    ? "border-[var(--primary)]/60 bg-[var(--primary)]/25 text-white"
                    : "border-blue-400/30 bg-blue-500/10 text-white/85 hover:bg-blue-500/20",
                )}
              >
                <span className="block font-semibold">{combatant?.name ?? id}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const picked = { ...step, spared: sparesPicked };
              if (!picksFirst(picked)) sendPicked(picked);
            }}
            className={cn(buttonClass, "border-[var(--primary)]/50 bg-[var(--primary)]/20 text-white")}
          >
            {sparesPicked.length
              ? t("game.combat.ruleset.spare.confirm", { count: sparesPicked.length })
              : t("game.combat.ruleset.spare.none")}
          </button>
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Who it gives disadvantage on their first save (1.255): Heightened Spell ──
  if (step?.stage === "heighten" && step.heighten) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60" id="ruleset-heighten-prompt">
          {t("game.combat.ruleset.heighten.prompt", { label: rulesetOptionLabel(step.option, t) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-heighten-prompt">
          {step.heighten.ids.map((id, index) => {
            const combatant = view.combatants.find((one) => one.id === id);
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={id}
                type="button"
                disabled={busy}
                onClick={() => sendPicked(step, id)}
                className={cn(
                  buttonClass,
                  combatant?.side === "enemy"
                    ? "border-amber-400/30 bg-amber-500/10 text-white/85 hover:bg-amber-500/20"
                    : "border-blue-400/30 bg-blue-500/10 text-white/85 hover:bg-blue-500/20",
                )}
              >
                <span className="block font-semibold">{combatant?.name ?? id}</span>
              </button>
            );
          })}
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Choosing how much of it to spend (1.251) ──
  if (step?.stage === "amount" && step.option.amount) {
    const option = step.option;
    const max = option.amount!.max;
    const typed = Number(amountText);
    const valid = Number.isInteger(typed) && typed >= 1 && typed <= max;
    const chooseAmount = (amount: number | null) => {
      afterMode(option, step.style, step.mode, amount, step.alters ?? null);
    };
    return (
      <div className="flex flex-col gap-2 p-3">
        <label className="text-xs text-white/60" htmlFor="ruleset-amount-input">
          {t("game.combat.ruleset.amount.prompt", { label: rulesetOptionLabel(option, t), max })}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="ruleset-amount-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step={1}
            value={amountText}
            disabled={busy}
            onChange={(event) => setAmountText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && valid) chooseAmount(typed);
            }}
            className="min-h-11 w-20 rounded-lg border border-white/15 bg-white/5 px-2 text-base tabular-nums text-white/90 sm:text-xs"
          />
          <button
            ref={first}
            type="button"
            disabled={busy || !valid}
            onClick={() => chooseAmount(typed)}
            className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
          >
            {t("game.combat.ruleset.amount.spend", { count: valid ? typed : 0 })}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => chooseAmount(null)}
            className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
          >
            {t("game.combat.ruleset.amount.fill")}
          </button>
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Paying for it out of another pool of the family ──
  const pools = step?.stage === "pay" ? (step.option.payWith ?? []) : [];
  if (step && pools.length > 0) {
    const option = step.option;
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-white/60">
          {t("game.combat.ruleset.upcast.prompt", { label: rulesetOptionLabel(option, t) })}
        </p>
        <div className="flex flex-wrap gap-2">
          {/* Its own pool is empty, so only a higher one pays for it now (1.171). */}
          {!option.upcastOnly && (
            <button
              ref={first}
              type="button"
              disabled={busy}
              onClick={() => paid(undefined)}
              className={cn(buttonClass, "border-white/15 bg-white/5 text-white/85 hover:bg-white/10")}
            >
              {t("game.combat.ruleset.upcast.own", { cost: rulesetOptionCostText(option, budgetLabel, t, distance) })}
            </button>
          )}
          {pools.map((pool, index) => (
            <button
              key={pool}
              ref={option.upcastOnly && index === 0 ? first : undefined}
              type="button"
              disabled={busy}
              onClick={() => paid(pool)}
              className={cn(buttonClass, "border-blue-400/25 bg-blue-500/10 text-white/85 hover:bg-blue-500/20")}
            >
              {/* More of the item's own charges (1.269). */}
              {pool.startsWith(RULESET_CHARGE_STEP_PREFIX)
                ? t("game.combat.ruleset.upcast.charges", {
                    count: Number(pool.slice(RULESET_CHARGE_STEP_PREFIX.length)),
                  })
                : t("game.combat.ruleset.upcast.pool", { pool })}
            </button>
          ))}
        </div>
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Picking it on the board ──
  // The cells are the board's to draw and the board's to finish; this is the prompt and the way
  // out, in the place the option was chosen from, so a player who changed their mind is not
  // hunting for it on the grid.
  if (step?.stage === "move" || step?.stage === "aim") {
    const option = step.option;
    const lay = step.lay;
    const area = step.stage === "aim" ? option.area : undefined;
    const wall = area?.shape === "wall";
    const copies = area?.copies ?? 1;
    const placed = lay?.at ? 1 + (lay.also?.length ?? 0) : 0;
    const turning = step.stage === "aim" && rulesetAimTurning(option, lay);
    const sendLaid = () => {
      const laid = rulesetAimSoFar(lay);
      if (!laid) return;
      if (picksFirst({ ...step, targets: [], cell: laid })) return;
      closeStep();
      onChoose(option.id, [], step.payWith, laid, step.style, step.mode, step.amount, step.alters);
    };
    // Who may go along on a teleport (1.276), ticked here while the board takes the cell.
    const carries = step.stage === "aim" ? option.teleport?.carries : undefined;
    const prompt =
      step.stage === "move"
        ? "game.combat.ruleset.board.movePrompt"
        : option.teleport
          ? option.teleport.cells.length === 0
            ? "game.combat.ruleset.board.teleportLeavePrompt"
            : "game.combat.ruleset.board.teleportPrompt"
          : turning
            ? "game.combat.ruleset.board.aimTurnPrompt"
            : wall && !lay?.ring
              ? "game.combat.ruleset.board.aimWallPrompt"
              : copies > 1
                ? "game.combat.ruleset.board.aimCopiesPrompt"
                : rulesetOptionHasAim(option)
                  ? "game.combat.ruleset.board.aimPrompt"
                  : "game.combat.ruleset.board.aimNobody";
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-amber-200">
          {t(prompt, { label: rulesetOptionLabel(option, t), name: actorName, count: copies, placed })}
        </p>
        {/* How a wall is laid (1.177) and how many copies are down (1.178): the board takes the cells. */}
        {carries && (
          <div className="flex flex-wrap gap-2">
            {carries.ids.map((id) => {
              const along = step.targets.includes(id);
              const full = !along && step.targets.length >= carries.count;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={busy || full}
                  aria-pressed={along}
                  onClick={() =>
                    setStep({
                      ...step,
                      targets: along ? step.targets.filter((one) => one !== id) : [...step.targets, id],
                    })
                  }
                  className={cn(buttonClass, along ? "border-[var(--primary)]/60 bg-[var(--primary)]/25" : "")}
                >
                  {t("game.combat.ruleset.board.teleportCarry", {
                    name: view.combatants.find((one) => one.id === id)?.name ?? id,
                  })}
                </button>
              );
            })}
          </div>
        )}
        {/* Out of the fight altogether (1.279), with whoever is ticked to go along. */}
        {option.teleport?.leaves && step.stage === "aim" && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const along = step.targets;
                closeStep();
                onChoose(
                  option.id,
                  [],
                  step.payWith,
                  along.length ? { carries: along } : undefined,
                  step.style,
                  step.mode,
                  step.amount,
                  step.alters,
                );
              }}
              className={buttonClass}
            >
              {t("game.combat.ruleset.board.teleportLeave")}
            </button>
          </div>
        )}
        {(wall || copies > 1) && (
          <div className="flex flex-wrap gap-2">
            {wall && area?.ring !== undefined && !turning && (
              <button
                type="button"
                disabled={busy}
                aria-pressed={!!lay?.ring}
                onClick={() => setStep({ ...step, lay: { ...lay, ring: !lay?.ring } })}
                className={cn(buttonClass, lay?.ring ? "border-[var(--primary)]/60 bg-[var(--primary)]/25" : "")}
              >
                {t("game.combat.ruleset.board.aimRing")}
              </button>
            )}
            {wall && area?.sided && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep({ ...step, lay: { ...lay, side: lay?.side === "near" ? "far" : "near" } })}
                className={buttonClass}
              >
                {t(
                  lay?.side === "near"
                    ? "game.combat.ruleset.board.aimSideNear"
                    : "game.combat.ruleset.board.aimSideFar",
                )}
              </button>
            )}
            {turning && (
              <button type="button" disabled={busy} onClick={sendLaid} className={buttonClass}>
                {t("game.combat.ruleset.board.aimAcross")}
              </button>
            )}
            {copies > 1 && placed > 0 && (
              <button type="button" disabled={busy} onClick={sendLaid} className={buttonClass}>
                {t("game.combat.ruleset.board.aimCastNow", { count: placed })}
              </button>
            )}
          </div>
        )}
        <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
      </div>
    );
  }

  // ── Pointing it at somebody ──
  if (step?.stage === "target" && rulesetOptionNeedsTargets(step.option)) {
    const option = step.option;
    const many = option.targets.count > 1;
    const targets = view.combatants.filter((combatant) => option.targetIds.includes(combatant.id));
    // The walls' sections it may strike instead (1.200), each by the first of its cells offered.
    const offered = new Set((option.walls ?? []).map((cell) => `${cell.x},${cell.y}`));
    const sections = (view.zones ?? []).flatMap((zone) =>
      (zone.sections ?? []).flatMap((section) => {
        const cell = section.cells.find((one) => offered.has(`${one.x},${one.y}`));
        return cell ? [{ wall: zone.label, health: section.health, max: section.max, cell }] : [];
      }),
    );
    return (
      <div className="flex flex-col gap-2 p-3">
        <p className="text-xs text-amber-200" id="ruleset-target-prompt">
          {many
            ? t(
                option.targets.repeat
                  ? "game.combat.ruleset.target.promptRepeat"
                  : "game.combat.ruleset.target.promptMany",
                {
                  label: rulesetOptionLabel(option, t),
                  count: option.targets.count,
                },
              )
            : t("game.combat.ruleset.target.prompt", { label: rulesetOptionLabel(option, t) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="ruleset-target-prompt">
          {targets.map((combatant, index) => {
            const picked = step.targets.includes(combatant.id);
            // Picked more than once (1.305): eldritch blast's beams at one target.
            const times = step.targets.filter((id) => id === combatant.id).length;
            return (
              <button
                ref={index === 0 ? first : undefined}
                key={combatant.id}
                type="button"
                disabled={busy}
                aria-pressed={many ? picked : undefined}
                onClick={() => pick(combatant.id)}
                className={cn(
                  buttonClass,
                  picked
                    ? "border-[var(--primary)]/60 bg-[var(--primary)]/25 text-white"
                    : combatant.side === "enemy"
                      ? "border-amber-400/30 bg-amber-500/10 text-white/85 hover:bg-amber-500/20"
                      : "border-blue-400/30 bg-blue-500/10 text-white/85 hover:bg-blue-500/20",
                )}
              >
                <span className="block font-semibold">{combatant.name}</span>
                <span className="mt-0.5 block text-[0.65rem] tabular-nums text-white/55">
                  {t("game.combat.ruleset.status.health", {
                    value: combatant.health.value,
                    max: combatant.health.max,
                  })}
                </span>
                {times > 1 && (
                  <span className="mt-0.5 block text-[0.65rem] font-semibold tabular-nums text-white/80">
                    {t("game.combat.ruleset.target.times", { count: times })}
                  </span>
                )}
              </button>
            );
          })}
          {sections.map((section, index) => (
            <button
              ref={index === 0 && targets.length === 0 ? first : undefined}
              key={`${section.cell.x},${section.cell.y}`}
              type="button"
              disabled={busy}
              onClick={() => {
                closeStep();
                onChoose(
                  option.id,
                  [],
                  step.payWith,
                  { wall: { x: section.cell.x, y: section.cell.y } },
                  step.style,
                  step.mode,
                  step.amount,
                  step.alters,
                );
              }}
              className={cn(buttonClass, "border-sky-300/30 bg-sky-500/10 text-white/85 hover:bg-sky-500/20")}
            >
              <span className="block font-semibold">
                {t("game.combat.ruleset.target.wall", { wall: section.wall })}
              </span>
              <span className="mt-0.5 block text-[0.65rem] tabular-nums text-white/55">
                {t("game.combat.ruleset.status.health", { value: section.health, max: section.max })}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {many && (
            <button
              type="button"
              disabled={busy || step.targets.length === 0}
              onClick={() => send(option, step.targets, step.payWith, step.style, step.mode)}
              className={cn(buttonClass, "border-[var(--primary)]/50 bg-[var(--primary)]/20 text-white")}
            >
              {t("game.combat.ruleset.target.confirm", { count: step.targets.length })}
            </button>
          )}
          <BackButton onClick={closeStep} label={t("game.combat.ruleset.target.back")} />
        </div>
      </div>
    );
  }

  // ── The menu itself ──
  // The shell's bottom panel takes whatever height its content asks for, so a menu stacked group
  // under group would take the stage's room and leave the two sides drawn over each other (or, on
  // a phone, leave no stage at all). The groups sit side by side, and a long list (a caster's)
  // scrolls inside its own bound.
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="flex max-h-[24svh] flex-col gap-2 overflow-y-auto px-3 py-2 outline-none sm:max-h-[34svh] sm:p-3"
    >
      {/* A phone's shell already says whose turn it is right above this, and has no height to say
          it twice; the group names go the same way there and the buttons wrap as one run. */}
      {/* A window is somebody else's moment inside this turn, so it is said on every width: on a
          phone the shell above still names the actor, and the two would otherwise contradict. */}
      {view.window ? (
        <p className="text-[0.65rem] uppercase tracking-wide text-[var(--primary)]">
          {t(
            `game.combat.ruleset.menu.window${view.window.targetIds?.some((id) => id !== view.window!.actorId) && (view.window.moment === "aimed" || view.window.moment === "hit") ? "Bystander" : WINDOW_PROMPTS[view.window.moment ?? view.window.kind]}`,
            {
              name: askedName,
              target: view.window.targetIds?.map(nameOf).join(", ") ?? askedName,
              mover: nameOf(view.window.sourceId ?? view.window.moverId),
              label: view.window.label ?? "",
              total: view.window.total ?? "",
              defense:
                view.window.defense === undefined
                  ? ""
                  : defenseLabel
                    ? `${defenseLabel} ${view.window.defense}`
                    : String(view.window.defense),
            },
          )}
        </p>
      ) : (
        <p className="hidden text-[0.65rem] uppercase tracking-wide text-white/45 sm:block">
          {t("game.combat.ruleset.menu.title", { name: actorName })}
        </p>
      )}
      <div className="flex flex-row flex-wrap items-start gap-2 sm:gap-x-6 sm:gap-y-3">
        {groups.map((group) => (
          <section
            key={group.kind}
            aria-label={t(group.labelKey)}
            className="contents sm:flex sm:min-w-0 sm:flex-col sm:gap-1.5"
          >
            <h4 className="hidden text-[0.6rem] font-semibold uppercase tracking-wide text-white/40 sm:block">
              {t(group.labelKey)}
            </h4>
            <div className="contents sm:flex sm:flex-wrap sm:gap-2">
              {group.options.map((option) => {
                const cost = rulesetOptionCostText(option, budgetLabel, t, distance);
                const forecast = rulesetOptionForecastText(option, t);
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={busy}
                    onClick={() => take(option)}
                    className={cn(
                      buttonClass,
                      "border-white/10 bg-white/5 text-white/80 hover:border-white/25 hover:bg-white/10 hover:text-white",
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-white/90">
                      <ArtIcon ids={option.icons ?? []} className="h-5 w-5" />
                      {rulesetOptionLabel(option, t)}
                    </span>
                    {option.cancelSave && (
                      <span className="block text-[0.65rem] text-white/55">
                        {t("game.combat.ruleset.menu.cancelSave", {
                          save: option.cancelSave.label,
                          dc: option.cancelSave.dc,
                        })}
                      </span>
                    )}
                    {cost && <span className="mt-0.5 block text-[0.65rem] text-white/45">{cost}</span>}
                    {forecast && <span className="block text-[0.65rem] text-white/45">{forecast}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <div className="flex flex-wrap gap-2 self-end">
          {view.window && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                closeStep();
                onChoose(RULESET_PASS_OPTION, []);
              }}
              className={cn(
                buttonClass,
                "border-white/10 bg-white/5 text-white/80 hover:border-white/25 hover:bg-white/10 hover:text-white",
              )}
            >
              {t("game.combat.ruleset.menu.pass")}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onFlee}
            className={cn(buttonClass, "border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white")}
          >
            {t("game.combat.ruleset.menu.flee")}
          </button>
        </div>
      </div>
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 rounded border border-white/15 px-3 text-xs text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
    >
      {label}
    </button>
  );
}
