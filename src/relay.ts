import { basename } from "node:path";
import type { PaneAgent } from "./herdr.js";

/**
 * Relay: carry something out of one agent's answer and into another agent's
 * prompt. `s` already pastes into the pane you came from, but the dock follows
 * focus, so going to agent B to send there swaps the list for B's. Relay keeps
 * A's list and asks which other agent should get the item.
 */

export interface RelayTarget {
  paneId: string;
  /** Short enough for the status line: the agent and its folder. */
  label: string;
}

/** Number keys pick a target, so there are at most nine. */
export const MAX_TARGETS = 9;

/**
 * Every other agent pane, nearest first: the same tab, then the same
 * workspace, then the rest, each in Herdr's own order. The followed agent and
 * the dock itself are left out.
 */
export function relayTargets(
  agents: PaneAgent[],
  from: { paneId: string; tabId?: string; workspaceId?: string },
  selfPaneId: string,
): RelayTarget[] {
  const distance = (agent: PaneAgent): number => {
    if (from.tabId !== undefined && agent.tab_id === from.tabId) return 0;
    if (from.workspaceId !== undefined && agent.workspace_id === from.workspaceId) return 1;
    return 2;
  };

  const others = agents
    .filter((agent) => agent.agent && agent.pane_id !== from.paneId && agent.pane_id !== selfPaneId)
    .map((agent, order) => ({ agent, order, distance: distance(agent) }))
    .sort((left, right) => left.distance - right.distance || left.order - right.order)
    .slice(0, MAX_TARGETS)
    .map(({ agent }) => ({ paneId: agent.pane_id, label: labelOf(agent) }));

  // Two agents of one kind in one folder would read the same; the pane id tells them apart.
  const counts = new Map<string, number>();
  for (const target of others) counts.set(target.label, (counts.get(target.label) ?? 0) + 1);
  return others.map((target) =>
    counts.get(target.label)! > 1 ? { ...target, label: `${target.label} ${target.paneId}` } : target,
  );
}

function labelOf(agent: PaneAgent): string {
  const who = agent.name?.trim() || agent.agent || "agent";
  const cwd = agent.cwd ?? agent.foreground_cwd;
  const folder = cwd ? basename(cwd) : "";
  return folder !== "" && folder !== who ? `${who} ${folder}` : who;
}

/** The question the status line holds while a target is picked. */
export function relayPrompt(what: string, targets: RelayTarget[]): string {
  const list = targets.map((target, index) => `${index + 1} ${target.label}`).join(" · ");
  return `relay ${what} → ${list} · esc cancels`;
}

/** The target a key names, if it is one of the listed numbers. */
export function targetForKey(targets: RelayTarget[], key: string): RelayTarget | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  return targets[Number(key) - 1];
}

/** The receipt once it has been pasted. */
export function relayReceipt(what: string, target: RelayTarget, text: string): string {
  const lines = text.trim().split("\n").length;
  return `relayed ${what} → ${target.label}${lines > 1 ? ` · ${lines} lines` : ""}`;
}
