import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, run, hc, exec, theme, props, openOverlay, closeOverlay, home, knownAgents } from "herdr";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WINDOW = 12;
const ALL = Symbol("all machines");

const machineLabel = (machine) => machine ?? "this computer";
const openKey = (machine, path) => `${machine ?? ""}\0${path}`;
const firstLine = (text) => (text ?? "").trim().split("\n")[0];
const tabLabel = (tabName) => (/^\d+$/.test(tabName) ? `tab ${tabName}` : tabName);

const LAUNCHABLE = ["claude", "codex", "pi", "omp"];
// herdr's program table lacks omp.
const OMP = { key: "omp", name: "omp", run: ["omp"], installed: null };
// herdr runs argv inside an interactive shell that outlives it.
const CLOSE_ON_SUCCESS = '"$@"; [ $? -eq 0 ] && hc kill "$HC_TERMINAL_ID"';

async function loadAgents(machine) {
  let list;
  try {
    list = await knownAgents({ on: machine });
  } catch {
    return [];
  }
  const launchable = list.filter((a) => LAUNCHABLE.includes(a.key)).map(({ key, name, run, installed }) => ({ key, name, run, installed }));
  if (!launchable.some((a) => a.key === "omp")) launchable.push(OMP);
  return launchable;
}

function tabName(tabs, key) {
  const taken = new Set(tabs.map((t) => t.name));
  if (!taken.has(key)) return key;
  for (let n = 2; ; n++) if (!taken.has(`${key} ${n}`)) return `${key} ${n}`;
}

function launch(row, agent, task) {
  const argv = ["sh", "-c", CLOSE_ON_SUCCESS, "agent", ...agent.run];
  const message = task ? { task } : {};
  if (row.space) {
    const tabs = spaces().find((s) => s.id === row.space.id)?.tabs ?? row.space.tabs;
    run("tab.new", { space: row.space.id, name: tabName(tabs, agent.key), argv, ...message });
  } else run("space.new", { folder: row.path, argv, ...message, ...(row.machine ? { machine: row.machine } : {}) });
}

// Agents put spinner frames, icon-font glyphs and one-character status marks ("π >") ahead of
// their task in the title; keep only the task, so a spinner frame is not a new title.
const cleanTitle = (title) =>
  title
    .replace(/[\u2800-\u28FF\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/gu, "")
    .replace(/^(?:(?:[^\p{L}\p{N}\s]+|[^\x00-\x7F])(?:\s+|$))+/u, "")
    .replace(/\s+/g, " ")
    .trim();
const agentDetail = (a) => {
  const app = a.app ?? a.program.name;
  const task = cleanTitle(a.title);
  return task && task !== app && task !== a.program.name ? `${app}  ${task}` : app;
};

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

const agentOf = (a) => ({ address: a.address, pane: a.pane, app: a.app ?? a.program.name, status: a.status });
const STATUS_ORDER = { working: 0, blocked: 1, done: 2, idle: 3 };
const tierOf = (row) => (row.kind === "folder" ? 5 : STATUS_ORDER[row.kind === "agent" ? row.agent.status : row.space.status] ?? 4);
const groupOf = (row, agentsBySpace) => {
  if (row.kind === "folder") return 2;
  const agentRow = row.kind === "agent" || (agentsBySpace.get(row.space.id)?.length ?? 0) > 0;
  return agentRow ? 0 : 1;
};

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
    ranked.push({ row, base, display, group: tokens.length ? groupOf(row, agentsBySpace) : 0, rank: score * 10, tier: tierOf(row), weight });
  };
  const spaceRowsDone = new Set();
  const considerSpace = (space, machine, path, display, displayLower, weight) => {
    const spaceAgents = agentsBySpace.get(space.id) ?? [];
    if (!spaceAgents.length) {
      consider({ kind: "open", space, machine, path }, space.name, space.name.toLowerCase(), display, displayLower, weight);
      return;
    }
    if (spaceRowsDone.has(space.id)) return;
    spaceRowsDone.add(space.id);
    const where = folders.get(space.id).map((p) => tilde(homeOf(machine), p)).join(" ");
    if (spaceAgents.length === 1) {
      const detail = agentDetail(spaceAgents[0]);
      consider({ kind: "open", space, machine, path, agent: agentOf(spaceAgents[0]) }, space.name, space.name.toLowerCase(), detail, `${where} ${detail}`.toLowerCase(), weight);
      return;
    }
    for (const a of spaceAgents) {
      const label = tabLabel(a.tab_name);
      const title = cleanTitle(a.title);
      const base = `${space.name} › ${label}`;
      const text = `${a.app ?? a.program.name}  ${title}`;
      consider({ kind: "agent", space, machine, path, agent: agentOf(a) }, base, base.toLowerCase(), text, `${where} ${text}`.toLowerCase(), weight);
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
  ranked.sort((a, b) => a.group - b.group || b.rank - a.rank || a.tier - b.tier || b.weight - a.weight);
  ranked.push({ row: { kind: "new", machine: scope === ALL ? null : scope }, base: "New space…", display: "~" });
  return ranked;
}

const KEYS = {
  escape: (nav) => nav.close(),
  enter: (nav, picked) => nav.go(picked, false),
  "cmd-enter": (nav, picked) => nav.openStep(picked),
  "alt-enter": (nav, picked) => nav.go(picked, true),
  "ctrl-x": (nav, picked) => nav.closeRow(picked),
  "ctrl-w": (nav) => nav.deleteWord(),
  up: (nav, _picked, count) => nav.move(-1, count),
  down: (nav, _picked, count) => nav.move(1, count),
};

const STEP_KEYS = {
  backspace: (nav) => (nav.taskInput.value() === "" ? nav.closeStep() : false),
  enter: (nav) => nav.launchStep(),
  up: (nav) => nav.moveStep(-1),
  down: (nav) => nav.moveStep(1),
};

export default class Navigator extends View {
  init(_props, cx) {
    this.query = "";
    this.at = 0;
    this.scope = ALL;
    this.done = false;
    this.armed = null;
    this.cmdHeld = false;
    this.machines = [null];
    this.sources = new Map([[null, { state: "loading" }]]);
    this.version = 0;
    this.cache = null;
    this.known = new Map();
    this.step = null;
    this.input = InputState.new({ placeholder: "Folder, space or machine…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.armed = null;
      this.at = 0;
      this.ranked();
      cx.notify();
    });
    // The input reports cmd-enter as a secondary submit.
    this.input.on("submit", (e, cx) => {
      if (!e?.secondary) return this.go(this.ranked()[this.at], false);
      this.openStep(this.ranked()[this.at]);
      cx.notify();
    });
    this.taskInput = InputState.new({ placeholder: "First message (optional)…" });
    this.taskInput.on("submit", () => this.launchStep());
    // The app keymap has no unbind and init runs on every open, so bind once per app run.
    globalThis.__navigatorTabBound ||= cx.bind_keys([{ keystroke: "tab", action: "navigator.next_scope", context: "Navigator" }]);
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      const [source, known] = await Promise.all([loadSource(null), loadAgents(null)]);
      this.known.set(null, known);
      this.setSource(null, source);
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
          const [source, known] = await Promise.all([loadSource(name), loadAgents(name)]);
          this.known.set(name, known);
          this.setSource(name, source);
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

  ranked() {
    const spaceList = spaces();
    const homeOf = (machine) => this.homeOf(machine);
    const folders = liveFolders(spaceList, panes(), homeOf);
    const agentsBySpace = new Map();
    const agentParts = [];
    for (const a of agents()) {
      if (!agentsBySpace.has(a.space)) agentsBySpace.set(a.space, []);
      agentsBySpace.get(a.space).push(a);
      agentParts.push([a.address, a.space, a.tab, a.tab_name, a.app ?? a.program.name, cleanTitle(a.title), a.status].join("\u0001"));
    }
    const spaceParts = spaceList.map((s) => [s.id, s.name, s.machine ?? "", s.status ?? "", ...folders.get(s.id)].join("\u0001")).join("\u0002");
    const key = [this.version, this.query, this.scope === ALL ? "\u0003all" : (this.scope ?? ""), spaceParts, agentParts.join("\u0002")].join("\u0004");
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
    } else if (row.agent && !forceNew) run("agent.focus", { terminal: row.agent.address });
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

  // shortcut: InputState has no caret getter, so ctrl-w deletes the query's last word
  // rather than the word before a moved caret; upgrade when it exposes a selection.
  deleteWord() {
    const current = this.input.value();
    if (!/\S/.test(current)) return;
    const next = current.trimEnd().replace(/\S+$/, "");
    this.input.set_value(next);
    this.query = next;
    this.at = 0;
    this.ranked();
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

  openStep(picked) {
    if (this.step || !picked || picked.row.kind === "new") return;
    this.step = { picked, at: 0 };
    this.taskInput.set_value("");
    this.taskInput.focus();
  }

  closeStep() {
    this.step = null;
    this.input.focus();
  }

  moveStep(step) {
    const count = this.known.get(this.step.picked.row.machine)?.length ?? 0;
    if (count) this.step.at = (this.step.at + step + count) % count;
  }

  launchStep(at = this.step?.at) {
    if (!this.step || this.done) return;
    const { row } = this.step.picked;
    const agent = this.known.get(row.machine)?.[at];
    if (!agent || agent.installed === false) return;
    this.done = true;
    this.close();
    launch(row, agent, this.taskInput.value().trim());
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
        .when(picked === selected, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(picked, false))
        .child(this.glyph(t, row))
        .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).when(open, (d) => d.font_semibold()).child(picked.base))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(picked.display))
        .when(row.machine !== null, (el) => el.child(this.chip(t, row.machine, false)))
        .child(
          this.cmdHeld && row.kind !== "new"
            ? div().w(60).flex_none().text_size(11).text_color(t.accent).child("run agent")
            : div().w(42).flex_none().text_size(11).text_color(open ? t.accent : t.dim).child(open ? "go to" : "new"),
        );
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

    const inputBox = (state, count) =>
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
        .child(Input.new(state).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child(count));

    const stepView = () => {
      const { picked } = this.step;
      const { row } = picked;
      const where = `${row.space ? row.space.name : picked.base}${row.machine ? ` on ${row.machine}` : ""}${row.space ? "" : " (new space)"}`;
      return v_flex()
        .gap(6)
        .child(div().text_size(11.5).text_color(t.dim).child(`Launch in ${where}`))
        .child(inputBox(this.taskInput, ""));
    };

    const agentRows = () => {
      const { picked, at } = this.step;
      const list = this.known.get(picked.row.machine);
      const note = (text) => [h_flex().mx(4).px(10).h(32).flex_none().items_center().text_color(t.dim).child(text)];
      if (!list) return note(`Asking ${machineLabel(picked.row.machine)} which agents it has…`);
      if (!list.length) return note(`No agents found on ${machineLabel(picked.row.machine)}`);
      const target = picked.row.space ? "new tab" : "new space";
      return list.map((a, i) => {
        const missing = a.installed === false;
        return h_flex()
          .id(`nav-agent-${i}`)
          .mx(4)
          .px(10)
          .h(32)
          .flex_none()
          .rounded(7)
          .gap(10)
          .items_center()
          .cursor_pointer()
          .when(i === at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.launchStep(i))
          .child(div().flex_none().w(140).truncate().text_color(missing ? t.dim : t.foreground).font_semibold().child(a.name))
          .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child(a.run.join(" ")))
          .child(div().w(80).flex_none().text_size(11).text_color(missing ? t.muted : t.accent).child(missing ? "not installed" : target));
      });
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
      .key_context("Navigator")
      .on_action("navigator.next_scope", (_e, cx) => {
        this.armed = null;
        this.nextScope();
        cx.notify();
      })
      .on_modifiers_changed((e, cx) => {
        if (this.cmdHeld === e.modifiers.platform) return;
        this.cmdHeld = e.modifiers.platform;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        const action = (this.step ? STEP_KEYS : KEYS)[e.keystroke];
        if (e.keystroke !== "ctrl-x" && this.armed !== null) {
          this.armed = null;
          cx.notify();
        }
        if (!action) return;
        if (action(this, selected, ranked.length) === false) return;
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
      .child(this.step ? stepView() : inputBox(this.input, `${ranked.length - 1}`))
      .child(v_flex().min_h(0).children(this.step ? agentRows() : shown.map(rowView)))
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
              .children(this.step ? ["↵ launch", "↑↓ agent", "⌫ back", "esc close"] : ["↵ go to / new", "⌘↵ agent", "⌥↵ new space"])
              .when(!this.step, (el) =>
                el.child(armed ? div().text_color(t.accent).child(`⌃X again closes ${armed.row.agent.app} in ${armed.base}`) : "⌃X close").child("esc close"),
              )
              .child(div().flex_1())
              .child(h_flex().gap(10).children(states.map(machineState))),
          )
          .when(errors.length > 0, (el) => el.child(div().truncate().text_color(t.muted).child(errors.map(([m, s]) => `${machineLabel(m)}: ${s.reason}`).join("; ")))),
      );
  }
}
