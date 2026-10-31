// Jump to a folder or space on any connected machine. Rows are every zoxide
// folder of every connected machine plus every open space, ranked as one list.
// Enter goes to the space already open in that folder, else makes one there.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, run, hc, exec, theme, props, closeOverlay, home } from "herdr";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WINDOW = 12;
const ALL = Symbol("all machines");

const machineLabel = (machine) => machine ?? "this computer";
const openKey = (machine, path) => `${machine ?? ""}\0${path}`;
const firstLine = (text) => (text ?? "").trim().split("\n")[0];

function isSubsequence(needle, hay) {
  let at = 0;
  for (const ch of needle) {
    at = hay.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

function tokenScore(token, base, path, machine) {
  if (base === token) return 100;
  if (base.startsWith(token)) return 80;
  if (base.includes(token)) return 60;
  if (isSubsequence(token, base)) return 30;
  if (path.includes(token)) return 20;
  if (machine.includes(token)) return 10;
  return -1;
}

function matchScore(tokens, base, path, machine) {
  let sum = 0;
  for (const token of tokens) {
    const score = tokenScore(token, base.toLowerCase(), path.toLowerCase(), machine.toLowerCase());
    if (score < 0) return -1;
    sum += score;
  }
  return sum;
}

function tilde(homeDir, path) {
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  if (path.startsWith(homeDir + "/")) return "~" + path.slice(homeDir.length);
  return path;
}

function parseZoxide(stdout) {
  const folders = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (m) folders.push({ path: m[2], frecency: parseFloat(m[1]) });
  }
  return folders;
}

async function loadSource(machine) {
  const [zoxide, homeDir] = await Promise.allSettled([
    exec("zoxide", ["query", "-l", "-s"], { on: machine }),
    machine ? exec("printenv", ["HOME"], { on: machine }) : Promise.resolve({ code: 0, stdout: home() }),
  ]);
  if (zoxide.status === "rejected") return { state: "error", reason: firstLine(zoxide.reason?.message ?? String(zoxide.reason)) };
  const z = zoxide.value;
  if (z.code !== 0) return { state: "error", reason: firstLine(z.stderr) || `zoxide exited ${z.code}` };
  const h = homeDir.status === "fulfilled" && homeDir.value.code === 0 ? homeDir.value.stdout.trim() : null;
  return { state: "ready", home: h || null, folders: parseZoxide(z.stdout) };
}

// Where each space is now: its terminals' live folders. A space's own folder
// is only where new terminals start, so it counts only when the space has no terminal.
function spaceFolders(spaceList, paneList, homeOf) {
  const spaceOfTab = new Map();
  for (const s of spaceList) for (const t of s.tabs) spaceOfTab.set(t.id, s.id);
  const folders = new Map(spaceList.map((s) => [s.id, []]));
  for (const p of paneList) {
    const id = p.terminal && p.cwd ? spaceOfTab.get(p.tab) : undefined;
    if (id && !folders.get(id).includes(p.cwd)) folders.get(id).push(p.cwd);
  }
  for (const s of spaceList) {
    const fallback = s.folder || homeOf(s.machine ?? null);
    if (!folders.get(s.id).length && fallback) folders.get(s.id).push(fallback);
  }
  return folders;
}

function rankedRows(sources, spaceList, paneList, query, scope) {
  // Remote homes stay unknown until printenv answers; this computer's is always known.
  const homeOf = (machine) => {
    const source = sources.get(machine);
    if (source?.state === "ready") return source.home;
    return machine === null ? home() : null;
  };
  const folders = spaceFolders(spaceList, paneList, homeOf);
  const openIndex = new Map();
  for (const s of spaceList) {
    for (const path of folders.get(s.id)) {
      const key = openKey(s.machine ?? null, path);
      if (!openIndex.has(key)) openIndex.set(key, s);
    }
  }

  const rows = [];
  const claimed = new Set();
  for (const [machine, source] of sources) {
    if (source.state !== "ready") continue;
    for (const { path, frecency } of source.folders) {
      const space = openIndex.get(openKey(machine, path));
      if (space) claimed.add(space.id);
      rows.push(space ? { kind: "open", space, machine, path, frecency } : { kind: "folder", machine, path, frecency });
    }
  }
  for (const s of spaceList) {
    if (!claimed.has(s.id)) rows.push({ kind: "open", space: s, machine: s.machine ?? null, path: folders.get(s.id)[0] ?? "", frecency: 0 });
  }

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = [];
  for (const row of rows) {
    if (scope !== ALL && row.machine !== scope) continue;
    const base = row.kind === "open" ? row.space.name : row.path.split("/").pop() || row.path;
    const display = tilde(homeOf(row.machine), row.path);
    const score = matchScore(tokens, base, display, machineLabel(row.machine));
    if (score < 0) continue;
    const rank = score * 10 + (row.kind === "open" ? 250 : 0) + Math.log(row.frecency + 1) * 6;
    ranked.push({ row, base, display, rank });
  }
  return ranked.sort((a, b) => b.rank - a.rank);
}

const KEYS = {
  escape: (nav) => nav.close(),
  enter: (nav, picked) => nav.go(picked, false),
  "alt-enter": (nav, picked) => nav.go(picked, true),
  "ctrl-x": (nav, picked) => nav.closeSpace(picked),
  up: (nav, _picked, count) => nav.move(-1, count),
  down: (nav, _picked, count) => nav.move(1, count),
  tab: (nav) => nav.nextScope(),
};

export default class Navigator extends View {
  init(_props, cx) {
    this.query = "";
    this.at = 0;
    this.scope = ALL;
    this.done = false;
    this.machines = [null];
    this.sources = new Map([[null, { state: "loading" }]]);
    this.input = InputState.new({ placeholder: "Folder, space or machine…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", () => this.go(this.ranked()[this.at], false));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      this.sources.set(null, await loadSource(null));
      cx.notify();
    });
    cx.spawn(async (cx) => {
      let names = [];
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) names = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      this.machines = [null, ...names];
      for (const name of names) this.sources.set(name, { state: "loading" });
      cx.notify();
      await Promise.all(
        names.map(async (name) => {
          this.sources.set(name, await loadSource(name));
          cx.notify();
        }),
      );
    });
  }

  ranked() {
    return rankedRows(this.sources, spaces(), panes(), this.query, this.scope);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Enter can reach both the key handler and the input's submit; only the first acts.
  go(picked, forceNew) {
    if (!picked || this.done) return;
    this.done = true;
    this.close();
    const { row } = picked;
    if (row.kind === "open" && !forceNew) run("space.select", { id: row.space.id });
    else run("space.new", row.machine ? { folder: row.path, machine: row.machine } : { folder: row.path });
  }

  closeSpace(picked) {
    if (picked?.row.kind !== "open" || this.done) return;
    this.done = true;
    this.close();
    run("space.close", { id: picked.row.space.id });
  }

  move(step, count) {
    if (count) this.at = (this.at + step + count) % count;
  }

  nextScope() {
    const scopes = [ALL, ...this.machines];
    this.scope = scopes[(scopes.indexOf(this.scope) + 1) % scopes.length];
    this.at = 0;
  }

  glyph(t, row) {
    const box = div().w(13).flex_none();
    if (row.kind === "folder") return box.text_color(t.dim).child("+");
    const status = row.space.status;
    if (status === "working") return box.text_color(t.working).frames(SPIN, 90).child(SPIN[0]);
    return box.text_color(status ? t[status] : t.accent).child("●");
  }

  chip(t, text, on) {
    return div()
      .px(6)
      .h(18)
      .flex_none()
      .rounded(5)
      .text_size(10.5)
      .text_color(on ? t.accent_foreground : t.muted)
      .bg(on ? t.accent : t.raised)
      .child(text);
  }

  render() {
    const t = theme();
    const ranked = this.ranked();
    this.at = Math.max(0, Math.min(this.at, ranked.length - 1));
    const selected = ranked[this.at];
    const start = Math.max(0, Math.min(this.at - Math.floor(WINDOW / 2), ranked.length - WINDOW));
    const shown = ranked.slice(start, start + WINDOW);
    const states = this.machines.map((m) => [m, this.sources.get(m) ?? { state: "loading" }]);
    const loading = states.some(([, s]) => s.state === "loading");
    const errors = states.filter(([, s]) => s.state === "error");

    const rowView = (picked, i) => {
      const { row } = picked;
      const open = row.kind === "open";
      return h_flex()
        .id(`nav-${start + i}`)
        .mx(4)
        .px(10)
        .h(32)
        .flex_none()
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(picked === selected, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(picked, false))
        .child(this.glyph(t, row))
        .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).when(open, (d) => d.font_semibold()).child(picked.base))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(picked.display))
        .when(row.machine !== null, (el) => el.child(this.chip(t, row.machine, false)))
        .child(div().w(42).flex_none().text_size(11).text_color(open ? t.accent : t.dim).child(open ? "go to" : "new"));
    };

    const scopeChip = (scope) =>
      div()
        .id(`nav-scope-${scope === ALL ? "all" : (scope ?? "here")}`)
        .cursor_pointer()
        .on_click((_e, cx) => {
          this.scope = scope;
          this.at = 0;
          cx.notify();
        })
        .child(this.chip(t, scope === ALL ? "all" : machineLabel(scope), scope === this.scope));

    const machineState = ([machine, source]) => {
      const el = h_flex().gap(4).items_center().flex_none();
      if (source.state === "loading") return el.child(div().frames(SPIN, 90).child(SPIN[0])).child(machineLabel(machine));
      if (source.state === "error") return el.text_color(t.muted).child(`${machineLabel(machine)} unavailable`);
      return el.child(`${machineLabel(machine)} ${source.folders.length}`);
    };

    return v_flex()
      .id("navigator")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const action = KEYS[e.keystroke];
        if (!action) return;
        action(this, selected, ranked.length);
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .children([ALL, ...this.machines].map(scopeChip))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child("tab switches machine")),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
          .child(div().text_size(11).text_color(t.dim).child(`${ranked.length}`)),
      )
      .child(v_flex().min_h(0).children(shown.map(rowView)))
      .when(!ranked.length, (el) => el.child(div().px(14).py(10).text_color(t.dim).child(loading ? "Loading…" : "Nothing matches")))
      .child(
        v_flex()
          .pt(6)
          .gap(4)
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(
            h_flex()
              .gap(14)
              .child("↵ go to / new")
              .child("⌥↵ new space anyway")
              .child("⌃X close space")
              .child("esc close")
              .child(div().flex_1())
              .child(h_flex().gap(10).children(states.map(machineState))),
          )
          .when(errors.length > 0, (el) => el.child(div().truncate().text_color(t.muted).child(errors.map(([m, s]) => `${machineLabel(m)}: ${s.reason}`).join("; ")))),
      );
  }
}
