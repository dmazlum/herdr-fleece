// Toggles the Fleece dock beside the focused agent (keys.json: "mod.open:fleece-dock").
// A key can only run a command, and a closed dock has no copy to receive one, so
// this opens as an invisible popup, does the toggle once, and closes itself.

import { View, div } from "gpui-kit";
import { agents, focused, panes, props, closeOverlay, notify, run } from "herdr";

function toggle() {
  const f = focused(), list = agents();
  const agent = list.find((a) => a.address === (f?.agent ?? f?.terminal)) ?? list.find((a) => a.tab === f?.tab);
  const tab = agent?.tab ?? f?.tab;
  const docks = panes().filter((p) => p.mod === "fleece" && p.tab === tab);
  if (docks.length > 0) {
    for (const dock of docks) run("pane.close", { pane: dock.pane });
    return;
  }
  const pane = agent && panes().find((p) => p.terminal === agent.address);
  if (!pane) return notify({ title: "Fleece", body: "Focus an agent to dock Fleece beside it.", level: "warning" });
  run("pane.split", { direction: "right", pane: pane.pane, mod: "fleece", props: { terminal: agent.address } });
  // The split takes focus; the agent keeps the keyboard, as the plugin's dock did.
  run("pane.focus", { pane: pane.pane });
}

export default class FleeceDock extends View {
  init(_props, cx) {
    cx.timer.after(0, () => {
      try { toggle(); } finally { closeOverlay(props().overlay); }
    });
  }

  render() {
    return div();
  }
}
