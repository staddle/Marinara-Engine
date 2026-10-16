import { normalizeImagePromptInstructions } from "@marinara-engine/shared";

function appendPromptingInstructions(prompt: string, instructions: unknown, kind: "image" | "video"): string {
  const normalizedInstructions = normalizeImagePromptInstructions(instructions);
  return normalizedInstructions
    ? `${prompt}\n\n<${kind}_prompting_instructions>\nApply these ${kind}-backend instructions when writing the provider-ready prompt. They are instructions, not text to copy into the prompt:\n${normalizedInstructions}\n</${kind}_prompting_instructions>`
    : prompt;
}

export function appendImagePromptInstructions(prompt: string, instructions: unknown): string {
  return appendPromptingInstructions(prompt, instructions, "image");
}

/** A video connection's instructions for the model that writes its video prompt. */
export function appendVideoPromptInstructions(prompt: string, instructions: unknown): string {
  return appendPromptingInstructions(prompt, instructions, "video");
}
