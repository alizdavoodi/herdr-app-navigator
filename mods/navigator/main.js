import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, run, hc, exec, theme, props, openOverlay, closeOverlay, home } from "herdr";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WINDOW = 12;
const ALL = Symbol("all machines");

const machineLabel = (machine) => machine ?? "this computer";
const openKey = (machine, path) => `${machine ?? ""}\0${path}`;
const firstLine = (text) => (text ?? "").trim().split("\n")[0];
const tabLabel = (tabName) => (/^\d+$/.test(tabName) ? `tab ${tabName}` : tabName);
// Agents put spinner frames, icon-font glyphs and one-character status marks ("π >") ahead of
// their task in the title; keep only the task, so a spinner frame is not a new title.
const cleanTitle = (title) =>
  title
    .replace(/[\u2800-\u28FF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/gu, "")
    .replace(/^(?:(?:[^\p{L}\p{N}\s]+|[^\x00-\x7F])(?:\s+|$))+/u, "")
    .replace(/\s+/g, " ")
    .trim();

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

function matchScore(tokens, baseLower, pathLower, machineLower) {
  let sum = 0;
  for (const token of tokens) {
    const score = tokenScore(token, baseLower, pathLower, machineLower);
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

// Derived once per load, not per render: herdr-app interrupts a render that runs too
// long, and the popup re-renders on every agent status change.
function folderRow(homeDir, path, frecency) {
  const base = path.split("/").pop() || path;
  const display = tilde(homeDir, path);
  return { path, base, display, baseLower: base.toLowerCase(), displayLower: display.toLowerCase(), weight: Math.log(frecency + 1) * 6 };
}

function parseZoxide(stdout, homeDir) {
  const folders = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (m) folders.push(folderRow(homeDir, m[2], parseFloat(m[1])));
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
  const h = homeDir.status === "fulfilled" && homeDir.value.code === 0 ? homeDir.value.stdout.trim() || null : null;
  return { state: "ready", home: h, folders: parseZoxide(z.stdout, h) };
}

function liveFolders(spaceList, paneList, homeOf) {
  const spaceOfTab = new Map();
  for (const s of spaceList) for (const t of s.tabs) spaceOfTab.set(t.id, s.id);
  const folders = new Map(spaceList.map((s) => [s.id, []]));
  for (const p of paneList) {
    const id = p.terminal && p.cwd ? spaceOfTab.get(p.tab) : undefined;
    if (id && !folders.get(id).includes(p.cwd)) folders.get(id).push(p.cwd);
  }
  for (const s of spaceList) {
    const startFolder = s.folder || homeOf(s.machine ?? null);
    if (!folders.get(s.id).length && startFolder) folders.get(s.id).push(startFolder);
  }
  return folders;
}

function rankedRows(sources, spaceList, folders, agentsBySpace, query, scope, homeOf) {
  const openIndex = new Map();
  for (const s of spaceList) {
    for (const path of folders.get(s.id)) {
      const key = openKey(s.machine ?? null, path);
      if (!openIndex.has(key)) openIndex.set(key, s);
    }
  }

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const machineLower = new Map();
  const ranked = [];
  const consider = (row, base, baseLower, display, displayLower, weight) => {
    if (scope !== ALL && row.machine !== scope) return;
    if (!machineLower.has(row.machine)) machineLower.set(row.machine, machineLabel(row.machine).toLowerCase());
    const score = matchScore(tokens, baseLower, displayLower, machineLower.get(row.machine));
    if (score < 0) return;
    ranked.push({ row, base, display, rank: score * 10 + (row.kind === "folder" ? 0 : 250) + weight });
  };
  const agentRowsDone = new Set();
  const considerSpace = (space, machine, path, display, displayLower, weight) => {
    const spaceAgents = agentsBySpace.get(space.id) ?? [];
    if (spaceAgents.length < 2) {
      consider({ kind: "open", space, machine, path }, space.name, space.name.toLowerCase(), display, displayLower, weight);
      return;
    }
    if (agentRowsDone.has(space.id)) return;
    agentRowsDone.add(space.id);
    for (const a of spaceAgents) {
      const label = tabLabel(a.tab_name);
      const title = cleanTitle(a.title);
      const base = `${space.name} › ${label}`;
      const text = `${a.app ?? a.program.name}  ${title}`;
      const where = `${folders.get(space.id).map((p) => tilde(homeOf(machine), p)).join(" ")} ${text}`.toLowerCase();
      const agent = { address: a.address, pane: a.pane, app: a.app ?? a.program.name };
      consider({ kind: "agent", space, machine, path, agent }, base, base.toLowerCase(), text, where, weight);
    }
  };

  const claimed = new Set();
  for (const [machine, source] of sources) {
    if (source.state !== "ready") continue;
    for (const f of source.folders) {
      const space = openIndex.get(openKey(machine, f.path));
      if (!space) {
        consider({ kind: "folder", machine, path: f.path }, f.base, f.baseLower, f.display, f.displayLower, f.weight);
        continue;
      }
      claimed.add(space.id);
      considerSpace(space, machine, f.path, f.display, f.displayLower, f.weight);
    }
  }
  for (const s of spaceList) {
    if (claimed.has(s.id)) continue;
    const machine = s.machine ?? null;
    const path = folders.get(s.id)[0] ?? "";
    const display = tilde(homeOf(machine), path);
    considerSpace(s, machine, path, display, display.toLowerCase(), 0);
  }
  ranked.sort((a, b) => b.rank - a.rank);
  ranked.push({ row: { kind: "new", machine: scope === ALL ? null : scope }, base: "New space…", display: "~" });
  return ranked;
}

const KEYS = {
  escape: (nav) => nav.close(),
  enter: (nav, picked) => nav.go(picked, false),
  "alt-enter": (nav, picked) => nav.go(picked, true),
  "ctrl-x": (nav, picked) => nav.closeRow(picked),
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
    this.armed = null;
    this.machines = [null];
    this.sources = new Map([[null, { state: "loading" }]]);
    this.version = 0;
    this.cache = null;
    this.input = InputState.new({ placeholder: "Folder, space or machine…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.armed = null;
      this.at = 0;
      this.ranked();
      cx.notify();
    });
    this.input.on("submit", () => this.go(this.ranked()[this.at], false));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      this.setSource(null, await loadSource(null));
      cx.notify();
    });
    cx.spawn(async (cx) => {
      let names = [];
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) names = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      this.machines = [null, ...names];
      for (const name of names) this.setSource(name, { state: "loading" });
      cx.notify();
      await Promise.all(
        names.map(async (name) => {
          this.setSource(name, await loadSource(name));
          cx.notify();
        }),
      );
    });
  }

  // Rank here, in the task or handler that changed the data, so render() finds the
  // rows cached: herdr-app interrupted the render that did this first ranking.
  setSource(machine, source) {
    this.sources.set(machine, source);
    this.version++;
    this.ranked();
  }

  homeOf(machine) {
    const source = this.sources.get(machine);
    if (source?.state === "ready") return source.home;
    return machine === null ? home() : null;
  }

  // The popup re-renders on every agent status change; rank again only when the
  // folders, the query, the filter, where the spaces are, or which agents are in them has changed.
  ranked() {
    const spaceList = spaces();
    const homeOf = (machine) => this.homeOf(machine);
    const folders = liveFolders(spaceList, panes(), homeOf);
    const agentsBySpace = new Map();
    const agentParts = [];
    for (const a of agents()) {
      if (!agentsBySpace.has(a.space)) agentsBySpace.set(a.space, []);
      agentsBySpace.get(a.space).push(a);
      agentParts.push([a.address, a.space, a.tab, a.tab_name, a.app ?? a.program.name, cleanTitle(a.title)].join("\u0001"));
    }
    const where = spaceList.map((s) => [s.id, s.name, s.machine ?? "", ...folders.get(s.id)].join("\u0001")).join("\u0002");
    const key = [this.version, this.query, this.scope === ALL ? "\u0003all" : (this.scope ?? ""), where, agentParts.join("\u0002")].join("\u0004");
    if (this.cache?.key !== key) this.cache = { key, rows: rankedRows(this.sources, spaceList, folders, agentsBySpace, this.query, this.scope, homeOf) };
    return this.cache.rows;
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
    if (row.kind === "new") {
      const machine = row.machine;
      openOverlay({
        mod: "prompt",
        kind: "dialog",
        width: 420,
        height: 210,
        props: {
          title: "new space",
          hint: machine ? `Starts in ~ on ${machine}` : "Starts in ~",
          command: { name: "space.new", args: machine ? { machine } : { folder: home() } },
        },
      });
    } else if (row.kind === "agent" && !forceNew) run("agent.focus", { terminal: row.agent.address });
    else if (row.kind === "open" && !forceNew) run("space.select", { id: row.space.id });
    else run("space.new", row.machine ? { folder: row.path, machine: row.machine } : { folder: row.path });
  }

  // pane.close ends the agent without asking, so the navigator asks with a second ctrl-x.
  closeRow(picked) {
    const row = picked?.row;
    if (!row || row.kind === "folder" || row.kind === "new" || this.done) return;
    if (row.kind === "agent" && this.armed !== row.agent.address) {
      this.armed = row.agent.address;
      return;
    }
    this.done = true;
    this.close();
    if (row.kind === "agent") run("pane.close", { pane: row.agent.pane });
    else run("space.close", { id: row.space.id });
  }

  move(step, count) {
    if (count) this.at = (this.at + step + count) % count;
  }

  nextScope() {
    const scopes = [ALL, ...this.machines];
    this.scope = scopes[(scopes.indexOf(this.scope) + 1) % scopes.length];
    this.at = 0;
    this.ranked();
  }

  glyph(t, row) {
    const box = div().w(13).flex_none();
    if (row.kind === "folder" || row.kind === "new") return box.text_color(t.dim).child("+");
    const status = row.kind === "agent" ? agents().find((a) => a.address === row.agent.address)?.status : spaces().find((s) => s.id === row.space.id)?.status;
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
    const errors = states.filter(([, s]) => s.state === "error");
    const armed = selected?.row.kind === "agent" && selected.row.agent.address === this.armed ? selected : null;

    const rowView = (picked, i) => {
      const { row } = picked;
      const open = row.kind === "open" || row.kind === "agent";
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
          this.armed = null;
          this.at = 0;
          this.ranked();
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
        if (e.keystroke !== "ctrl-x" && this.armed !== null) {
          this.armed = null;
          cx.notify();
        }
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
          .child(div().text_size(11).text_color(t.dim).child(`${ranked.length - 1}`)),
      )
      .child(v_flex().min_h(0).children(shown.map(rowView)))
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
              .child(armed ? div().text_color(t.accent).child(`⌃X again closes ${armed.row.agent.app} in ${armed.base}`) : "⌃X close")
              .child("esc close")
              .child(div().flex_1())
              .child(h_flex().gap(10).children(states.map(machineState))),
          )
          .when(errors.length > 0, (el) => el.child(div().truncate().text_color(t.muted).child(errors.map(([m, s]) => `${machineLabel(m)}: ${s.reason}`).join("; ")))),
      );
  }
}
