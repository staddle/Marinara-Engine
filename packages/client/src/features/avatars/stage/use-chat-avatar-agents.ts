// ──────────────────────────────────────────────
// Avatar stage: which avatar agents can show in a chat (lane: base)
// ──────────────────────────────────────────────
// Read by the chat surfaces before they load the lazy stage, so it stays tiny: an agent shows when the chat
// turned it on and its package is installed and active.
import { useMemo } from "react";
import type { AvatarAgentId } from "@marinara-engine/shared";
import { useInstalledCapabilityPackages } from "../../../hooks/use-capability-packages";
import { chatAvatarAgentIds } from "./avatar-stage-logic";

export function useChatAvatarAgentIds(chatMeta: { enableAgents?: unknown; activeAgentIds?: unknown }): AvatarAgentId[] {
  const wanted = chatAvatarAgentIds(chatMeta).join(",");
  const { data: installed } = useInstalledCapabilityPackages(wanted.length > 0);
  return useMemo(
    () =>
      (wanted ? (wanted.split(",") as AvatarAgentId[]) : []).filter((id) =>
        installed?.some((item) => item.id === id && item.status === "active"),
      ),
    [installed, wanted],
  );
}
