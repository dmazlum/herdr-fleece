// Fleece for the Herdr app: the focused agent's last answer, and what is worth
// carrying out of it. One mod, two shapes:
//
// - dock: a panel (or a pane) listing the files the agent edited and the code,
//   commands, paths and links from its last few turns. Click a row to copy it.
// - frame: `mod.open:fleece` opens the whole answer as rendered Markdown.
//
// The transcript is read by engine.mjs, run with the user's Node: a mod has no
// file system or clipboard of its own, and the parser is the same code the
// Herdr plugin uses.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import {
  exec, agents, focused, panes, props, openOverlay, closeOverlay, notify, theme, settings, appHome,
  run, nextCommand,
} from "herdr";

const ENGINE = () => `${appHome()}/mods/fleece/engine.mjs`;
const FRAME = { kind: "dialog", width: 0.7, height: 0.85 };
const SECTIONS = [["file", "FILES"], ["code", "CODE"], ["command", "COMMANDS"], ["path", "PATHS"], ["link", "LINKS"]];
const DEFAULT_KEYS = { reload: "r", send: "s", open: "e", older: "[", newer: "]", frame: "o", "copy-answer": "y", save: "m", close: "q" };

async function engine(args) {
  let r;
  try {
    r = await exec("node", [ENGINE(), ...args]);
  } catch (e) {
    return { ok: false, error: `Fleece needs Node 20+ on PATH (${String(e)})` };
  }
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try { return JSON.parse(line); }
  catch { return { ok: false, error: (r.stderr || r.stdout).trim() || `engine exited ${r.code}` }; }
}

// The agent to follow: the focused terminal when it is one, else the one
// already followed, else the first agent in the shown tab. Clicking the dock
// itself focuses a mod pane, which must not lose the agent behind it.
function follow(previous) {
  const list = agents(), f = focused();
  const here = list.find((a) => a.address === (f?.agent ?? f?.terminal));
  if (here) return here;
  const kept = previous && list.find((a) => a.address === previous);
  if (kept) return kept;
  return list.find((a) => a.tab === f?.tab) ?? null;
}

function toast(reply, ok) {
  if (reply.ok) notify({ title: "Fleece", body: ok ?? reply.message, level: "success", timeout: 2500 });
  else notify({ title: "Fleece", body: reply.error, level: "error" });
}

export default class Fleece extends View {
  init(_props, cx) {
    this.frame = Boolean(props()?.overlay);
    this.handle = cx.focus_handle();
    this.data = null;
    this.error = null;
    this.armed = null; // "send" | "open" while waiting for an item key
    this.pin = props()?.pin ?? null;
    this.address = props()?.terminal ?? null;
    this.signature = "";

    if (this.frame) {
      this.address ??= follow(null)?.address ?? null;
      this.handle.focus();
      cx.timer.after(120, () => this.handle.focus());
      this.load(cx);
      return;
    }
    // Agent status and focus are live data, so this only compares strings;
    // the engine runs when the followed agent or its status actually changes.
    this.tick(cx);
    cx.timer.every(1200, (cx) => this.tick(cx));
    // keys.json: "cmd-shift-y": "fleece.copy" reaches a shown dock.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "copy") this.act(["copy", ...this.turnArgs()], cx);
        else if (command === "copy-code") this.act(["copy", "--code", ...this.turnArgs()], cx);
        else if (command === "save") this.act(["save", ...this.turnArgs()], cx);
        else if (command === "journal") this.act(["journal", "--terminal", this.address], cx);
        else if (command === "frame") this.openFrame();
        else if (command === "reload") this.load(cx);
      }
    });
  }

  tick(cx) {
    const agent = follow(this.address);
    const signature = agent ? `${agent.address}|${agent.status}` : "";
    if (signature === this.signature) return;
    if (agent?.address !== this.address) this.pin = null;
    this.signature = signature;
    this.address = agent?.address ?? null;
    // Mid-answer the transcript has nothing new to show; wait for it to stop.
    if (agent?.status === "working" && this.data) return cx.notify();
    this.load(cx);
  }

  load(cx) {
    if (!this.address) { this.data = null; this.error = null; return cx.notify(); }
    if (this.address.includes("/")) {
      this.data = null; this.error = "Agents on other machines are not supported yet.";
      return cx.notify();
    }
    const address = this.address, pin = this.pin;
    cx.spawn(async (cx) => {
      const args = ["state", "--terminal", address];
      if (pin !== null) args.push("--pin", String(pin));
      if (!this.frame) args.push("--journal");
      const reply = await engine(args);
      if (address !== this.address || pin !== this.pin) return;
      this.data = reply.ok ? reply : null;
      this.error = reply.ok ? null : reply.error;
      if (reply.journal) notify({ title: "Fleece", body: reply.journal, timeout: 2500 });
      cx.notify();
    });
  }

  keys() { return { ...DEFAULT_KEYS, ...(this.data?.keys ?? {}) }; }

  step(direction, cx) {
    const list = this.data?.answers ?? [];
    const here = list.indexOf(this.data?.turn?.index);
    const next = here + direction;
    if (here < 0 || next < 0 || next >= list.length) return;
    this.pin = next === list.length - 1 ? null : list[next];
    this.load(cx);
  }

  turnArgs() {
    const turn = this.data?.turn?.index;
    return ["--terminal", this.address, ...(turn ? ["--turn", String(turn)] : [])];
  }

  act(args, cx, ok) {
    cx.spawn(async (cx) => { toast(await engine(args), ok); cx.notify(); });
  }

  copyItem(item, cx) {
    this.act(["clip", "--text", item.text], cx, `copied ${item.kind} · ${item.label.slice(0, 60)}`);
  }

  // Pasted, never submitted: the person presses Enter in the agent.
  sendItem(item, cx) {
    const address = this.address;
    cx.spawn(async (cx) => {
      const reply = await engine(["clip", "--text", item.text]);
      if (!reply.ok) return toast(reply);
      run("pane.focus", { terminal: address });
      run("terminal.paste");
      cx.notify();
    });
  }

  openItem(item, cx) {
    if (!item.open) return notify({ title: "Fleece", body: `a ${item.kind} has nothing to open`, level: "warning" });
    this.act(["open", "--target", item.open, ...(item.kind === "link" ? ["--link"] : [])], cx);
  }

  openFrame() {
    openOverlay({ mod: "fleece", props: { terminal: this.address, pin: this.pin }, ...FRAME });
  }

  // From the frame: put a dock beside the agent's pane, unless its tab has one.
  openDock() {
    const agent = panes().find((p) => p.terminal === this.address);
    closeOverlay(props().overlay);
    if (!agent) return notify({ title: "Fleece", body: "that agent has no pane here", level: "warning" });
    if (panes().some((p) => p.mod === "fleece" && p.tab === agent.tab)) return;
    run("pane.split", { direction: "right", pane: agent.pane, mod: "fleece", props: { terminal: this.address } });
  }

  onKey(e, cx) {
    const k = this.keys(), key = e.key_char ?? e.key;
    if (e.modifiers?.control || e.modifiers?.platform || e.modifiers?.alt) return;
    if (e.key === "escape") {
      if (this.armed) { this.armed = null; return cx.notify(); }
      if (this.frame) closeOverlay(props().overlay);
      return;
    }
    const items = this.data?.items ?? [];
    if (this.armed) {
      const item = items.find((i) => i.key === key), mode = this.armed;
      this.armed = null;
      if (item) mode === "send" ? this.sendItem(item, cx) : this.openItem(item, cx);
      return cx.notify();
    }
    if (key === k["copy-answer"]) return this.act(["copy", ...this.turnArgs()], cx);
    if (key === k.save) return this.act(["save", ...this.turnArgs()], cx);
    if (key === k.older) return this.step(-1, cx);
    if (key === k.newer) return this.step(1, cx);
    if (key === k.reload) return this.load(cx);
    if (this.frame) {
      if (key === "c") return this.act(["copy", "--code", ...this.turnArgs()], cx);
      if (key === "d") return this.openDock();
      if (key === k.close) return closeOverlay(props().overlay);
      return;
    }
    if (key === k.frame) return this.openFrame();
    if (key === k.send || key === k.open) { this.armed = key === k.send ? "send" : "open"; return cx.notify(); }
    const item = items.find((i) => i.key === key);
    if (item) this.copyItem(item, cx);
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("fleece").track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .size_full().min_h(0).text_size(12).text_color(t.foreground);
    return this.frame ? this.renderFrame(root, t) : this.renderDock(root, t);
  }

  button(id, label, t, handler) {
    return div().id(id).px(7).h(22).flex().items_center().rounded(5).text_size(11).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => handler(cx))
      .child(label);
  }

  message(root, t, text) {
    return root.bg(t.chrome).p(14).child(div().text_color(this.error ? t.blocked : t.dim).child(text));
  }

  renderDock(root, t) {
    const d = this.data, k = this.keys();
    if (!this.address) return this.message(root, t, "Focus an agent to fleece its answers.");
    if (this.error) return this.message(root, t, this.error);
    if (!d) return this.message(root, t, "Reading the transcript…");

    const mono = settings().font_family ?? "JetBrains Mono";
    const items = d.items ?? [];
    const header = h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b_1().border_color(t.border)
      .child(div().font_semibold().child("Fleece"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11).child(d.label))
      .child(div().text_size(10.5).text_color(d.pinned ? t.blocked : t.idle).child(d.pinned ? "pinned" : "live"));

    const sections = SECTIONS.map(([kind, title]) => [title, items.filter((i) => i.kind === kind)])
      .filter(([, rows]) => rows.length > 0);

    const list = v_flex().id("fleece-items").flex_1().min_h(0).overflow_y_scrollbar().py(6).gap(8)
      .when(sections.length === 0, (el) => el.child(div().px(12).text_color(t.dim).child("Nothing to carry out of these turns.")))
      .children(sections.map(([title, rows]) => v_flex().gap(1)
        .child(div().px(12).text_size(10.5).font_medium().text_color(t.dim).child(title))
        .children(rows.map((item, n) => this.row(item, `${title}-${n}`, t, mono)))));

    const hint = this.armed
      ? `${this.armed} — press an item key · Esc cancels`
      : `key copy · ${k.send} send · ${k.open} open · ${k["copy-answer"]} all · ${k.save} save · ${k.frame} frame · ${k.older}${k.newer} turn`;

    const footer = v_flex().flex_none().border_t_1().border_color(t.border).px(6).py(4).gap(2)
      .child(h_flex().gap(2).flex_wrap()
        .child(this.button("f-copy", "Copy all", t, (cx) => this.act(["copy", ...this.turnArgs()], cx)))
        .child(this.button("f-save", "Save", t, (cx) => this.act(["save", ...this.turnArgs()], cx)))
        .child(this.button("f-frame", "Frame", t, () => this.openFrame()))
        .child(div().flex_1())
        .child(this.button("f-older", "‹", t, (cx) => this.step(-1, cx)))
        .child(this.button("f-newer", "›", t, (cx) => this.step(1, cx))))
      .child(div().px(4).text_size(10.5).text_color(this.armed ? t.accent : t.dim).truncate().child(hint));

    return root.bg(t.chrome).child(header).child(list).child(footer);
  }

  row(item, id, t, mono) {
    const code = item.kind === "code" || item.kind === "command";
    return h_flex().id(`row-${id}`).h(24).mx(4).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.copyItem(item, cx))
      .child(div().w(14).flex_none().text_size(10.5).text_color(this.armed ? t.accent : t.dim).child(item.key ?? ""))
      .when(Boolean(item.tag), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(item.tag)))
      .child(div().flex_1().min_w(0).truncate().when(code, (el) => el.font_family(mono).text_size(11.5)).child(item.label))
      .when(Boolean(item.detail), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(item.detail)))
      .child(this.button(`send-${id}`, "send", t, (cx) => this.sendItem(item, cx)))
      .when(Boolean(item.open), (el) => el.child(this.button(`open-${id}`, "open", t, (cx) => this.openItem(item, cx))));
  }

  renderFrame(root, t) {
    const d = this.data, k = this.keys();
    root = root.bg(t.popover);
    if (!this.address) return this.message(root, t, "No agent is focused.");
    if (this.error) return this.message(root, t, this.error);
    if (!d?.turn) return this.message(root, t, d ? "This session has no answer yet." : "Reading the transcript…");

    const turn = d.turn;
    const meta = [`turn ${turn.index}`, turn.model, d.pinned ? `${d.answers.length - 1 - d.answers.indexOf(turn.index)} back` : null]
      .filter(Boolean).join(" · ");
    return root
      .child(v_flex().flex_none().px(18).pt(14).pb(10).gap(4).border_b_1().border_color(t.border)
        .child(h_flex().items_center().justify_between()
          .child(div().text_size(14).font_semibold().child("Fleece"))
          .child(div().text_size(11).text_color(t.dim).child(meta)))
        .when(Boolean(turn.prompt), (el) => el.child(div().text_size(11.5).text_color(t.muted).truncate().child(`› ${turn.prompt.split("\n")[0]}`))))
      .child(div().id("fleece-answer").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12)
        .child(TextView.markdown(`fleece-md-${turn.index}`, turn.text).selectable(true)))
      .child(h_flex().flex_none().h(34).px(12).gap(2).items_center().border_t_1().border_color(t.border)
        .child(this.button("x-copy", `${k["copy-answer"]} Copy`, t, (cx) => this.act(["copy", ...this.turnArgs()], cx)))
        .child(this.button("x-code", "c Copy code", t, (cx) => this.act(["copy", "--code", ...this.turnArgs()], cx)))
        .child(this.button("x-save", `${k.save} Save`, t, (cx) => this.act(["save", ...this.turnArgs()], cx)))
        .child(this.button("x-dock", "d Dock", t, () => this.openDock()))
        .child(div().flex_1())
        .child(this.button("x-older", `${k.older} Older`, t, (cx) => this.step(-1, cx)))
        .child(this.button("x-newer", `Newer ${k.newer}`, t, (cx) => this.step(1, cx)))
        .child(this.button("x-close", "Esc", t, () => closeOverlay(props().overlay))));
  }
}
