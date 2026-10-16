// ──────────────────────────────────────────────
// Service: Elemental Reaction System
//
// Implements element-based combat chains: the
// "default" preset defines elements, auras, and
// reaction rules.
// ──────────────────────────────────────────────

import { WORLD_DEFAULT_ELEMENTS, worldElementId, type WorldElementSet } from "@marinara-engine/shared";
import type { StatusEffect } from "./combat.service.js";

// ── Core types ──

export interface ElementDefinition {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface ReactionRule {
  /** Element already applied (aura) */
  trigger: string;
  /** Incoming element */
  appliedWith: string;
  /** Resulting reaction name */
  reaction: string;
  /** Damage multiplier applied to the triggering hit */
  damageMultiplier: number;
  /** Status effects inflicted on the target */
  effects: StatusEffect[];
  /** Short description for narration */
  description: string;
}

export interface ElementPreset {
  name: string;
  elements: ElementDefinition[];
  reactions: ReactionRule[];
}

/** Element aura currently on a combatant */
export interface ElementAura {
  element: string;
  /** Gauge units remaining (consumed on reaction) */
  gauge: number;
  /** Who applied the aura */
  sourceId: string;
}

export interface ReactionResult {
  reaction: string;
  description: string;
  damageMultiplier: number;
  appliedEffects: StatusEffect[];
  consumedAura: boolean;
}

// ── The game's elements (worldgen W6c) ──
// The classic six and their reactions live in shared (`WORLD_DEFAULT_ELEMENTS`), beside a setting
// kit's own (`worldElementSet`), so the fight, the weather, the tactical wheel and the screen read one set.

/** The elements a fight reads: a setting kit's set, or the classic six for a preset name (only
 *  "default" exists). */
export function getElementPreset(preset?: string | WorldElementSet | null): ElementPreset {
  const set = preset && typeof preset === "object" ? preset : WORLD_DEFAULT_ELEMENTS;
  return {
    name: preset && typeof preset === "object" ? "Setting kit" : "Classic RPG",
    elements: set.elements.map((element) => ({
      id: element.id,
      name: element.label,
      emoji: element.emoji,
      color: element.color,
    })),
    reactions: set.reactions,
  };
}

// ── Reaction resolution ──

/**
 * Apply an element to a target that may already have an aura.
 * Returns the reaction (if any) and updated aura.
 */
export function resolveElementApplication(
  existingAura: ElementAura | null,
  incomingElement: string,
  sourceId: string,
  preset?: string | WorldElementSet,
): { reaction: ReactionResult | null; newAura: ElementAura | null } {
  const { reactions } = getElementPreset(preset);
  const set = preset && typeof preset === "object" ? preset : WORLD_DEFAULT_ELEMENTS;
  // Read as the set's own elements, so "pyro" from one telling and "fire" from another are one element.
  const idOf = (word: string) => worldElementId(set, word) ?? word.trim().toLowerCase();

  // No existing aura → apply as new aura
  if (!existingAura) {
    return {
      reaction: null,
      newAura: { element: incomingElement, gauge: 1, sourceId },
    };
  }

  // Same source re-applying same element → refresh gauge
  if (idOf(existingAura.element) === idOf(incomingElement) && existingAura.sourceId === sourceId) {
    return {
      reaction: null,
      newAura: { ...existingAura, gauge: Math.min(2, existingAura.gauge + 0.5) },
    };
  }

  // Look for a reaction
  const rule = reactions.find(
    (r) => r.trigger === idOf(existingAura.element) && r.appliedWith === idOf(incomingElement),
  );

  if (rule) {
    // Reaction found — consume aura
    const newGauge = existingAura.gauge - 1;
    return {
      reaction: {
        reaction: rule.reaction,
        description: rule.description,
        damageMultiplier: rule.damageMultiplier,
        appliedEffects: rule.effects.map((e) => ({ ...e })),
        consumedAura: newGauge <= 0,
      },
      newAura: newGauge > 0 ? { ...existingAura, gauge: newGauge } : null,
    };
  }

  // No reaction — overwrite aura with new element
  return {
    reaction: null,
    newAura: { element: incomingElement, gauge: 1, sourceId },
  };
}

/**
 * Compute bonus damage from an elemental reaction.
 * Takes the base finalDamage and applies the reaction multiplier.
 */
export function applyReactionDamage(baseDamage: number, reaction: ReactionResult): number {
  return Math.floor(baseDamage * reaction.damageMultiplier);
}
