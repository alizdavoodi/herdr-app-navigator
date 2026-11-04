# Navigator

A popup at the top of the window for jumping to a folder. You type a few letters, and one ranked list shows matching zoxide folders from this computer and every connected machine, along with every open space. Enter goes to the space already working in that folder, or makes a new space there on the right machine.

![Navigator](preview.png)

## What you see

The popup is 680px wide and up to 80% of the window tall. It sits 40px below the top edge on the theme's `popover` color, with 18px padding and 13px text. From top to bottom:

1. **Machine chips.** One 18px-tall chip each for "all", "this computer", and every connected machine, with 10.5px text and 5px corners. The selected chip is `accent` with `accent_foreground` text. The others are `raised` with `muted` text. "tab switches machine" sits at the right in 11px `dim` text.
2. **Search field.** It is 36px tall with 9px corners, a 1px `accent` border, and a `background` fill. It holds the input (placeholder "Folder, space or machine…") and the count of matching rows in 11px `dim` text.
3. **Rows.** At most 12 rows show at a time, each 32px tall with 7px corners. The selected row has the `selected` background. A row under the pointer has the `hover` background. The last row is always "New space…", whatever the query. Each row shows, from left to right:
   - A glyph in a 13px box. A folder row and the "New space…" row have a `dim` `+`, since Enter makes a space there. An open-space row has a `●` in its agent status color (`working`, `blocked`, `done`, `idle`), or `accent` when no agent reports. A space with a working agent shows a braille spinner in `working` instead.
   - The name, at most 220px wide, in `foreground`. It is the space name for an open row (semibold), the last path segment for a folder row, and "New space…" for the last row.
   - The path in 11.5px `dim` text, with the machine's home shortened to `~`. This computer's home comes from `home()` even when its zoxide fails. It truncates at the end. A space with one agent shows that agent's app and cleaned title instead, as `app  title`, or the app alone when the title is empty or names the app ("Claude Code" for `claude-code`). A space with an agent shows one row, searched on all of the space's live folders. Typing a folder word still finds the row.
   - A machine chip, only on rows from another machine. The "New space…" row shows the filtered machine's chip when the filter is a remote machine.
   - "go to" in `accent` on open rows, or "new" in `dim` on folder rows and the "New space…" row. While ⌘ is held, every row except "New space…" reads "run agent" in `accent`, and releasing ⌘ restores it.
   - A space with two or more agents shows one row per agent instead of its space row. The name is `space › tab N`, or `space › <tab name>` when the tab has a name. The glyph takes that agent's status. The agent's app and cleaned title replace the path. The row is semibold and shows "go to" like an open row.
4. **Footer.** A 1px `border` line on top, then 11px `dim` text. The left side lists the keys: "↵ go to / new", "⌘↵ agent", "⌥↵ new space", "⌃X close", and "esc close". While a `ctrl-x` is armed on the selected agent row, "⌃X close" reads `⌃X again closes <app> in <row>` in `accent`. In the agent step the keys read "↵ launch", "↑↓ agent", "⌫ back", and "esc close". The right side shows each machine's state: a braille spinner and its name while it loads, its name and folder count when ready, or `<name> unavailable` in `muted` on failure. If any machine failed, a second line in `muted` reads `<name>: <reason>` for each one. The reason is the first line of the error `exec` gave or of zoxide's stderr, else `zoxide exited <code>`.

The agent step replaces the search field and the rows while it is open:

1. **Target line.** 11.5px `dim` text reading `Launch in <space name>`. It uses the space's name even on a `space › tab` row. A remote row adds ` on <machine>`. A folder row names the folder's last segment and adds ` (new space)`.
2. **Message field.** Styled like the search field, with the placeholder "First message (optional)…" and no count. It is empty and focused each time the step opens.
3. **Agent rows.** One 32px row per agent, styled like the list rows: the agent's name in semibold `foreground`, its `run` joined with spaces in 11.5px `dim`, and "new tab" (space rows) or "new space" (folder rows) in 11px `accent` at the right. An agent whose `installed` is `false` shows its name in `dim` and "not installed" in `muted`. While the row's machine has not answered, one `dim` row reads "Asking <machine> which agents it has…". When it answered with an error, one `dim` row reads "No agents found on <machine>".

## How it behaves

- Typing filters and ranks the list and moves the selection to the top row. Navigator splits the query on whitespace, and every word has to match. A word scores 100 when it equals the row's name, 80 when the name starts with it, 60 when the name contains it, and 30 when its letters appear in order in the name. It scores 20 when the `~` path contains it, and 10 when the machine name ("this computer" for this one) contains it. A word that matches none of these drops the row. Matching ignores case. An agent row's name is `space › tab`, and its path is the space's live `~` folders plus the agent's app and title.
- Rows sort by four keys in turn. First, only while a query is typed, the row's kind: rows that carry an agent (an agent row, or an open space with one agent), then other open spaces, then folders. An empty query skips this key. Then relevance, the score sum times 10. Then status, in the order working, blocked, done, idle, then no agent. Then `ln(frecency + 1) * 6`. With an empty query, open spaces and agents come first in status order, then folders by zoxide frecency.
- A folder is open when a terminal in a space on the same machine has that exact live working directory. A space with no terminal counts as open in its own folder (its machine's home when the folder is empty). An open space whose folders zoxide does not list still gets its own row.
- `enter` or a click on a space with no agent goes there with `space.select`. On an agent row, or on a space with one agent, it goes to that agent with `agent.focus {terminal}`. On a folder row, it makes a space there with `space.new`. `alt-enter` always makes a new space. `ctrl-x` on an open row, including a space with one agent, closes the popup and runs `space.close`, and the app asks to confirm. `ctrl-x` does nothing on a folder row or on the "New space…" row.
- `enter`, `alt-enter`, or a click on "New space…" closes the popup and opens the shipped `prompt` mod as a 420×210 dialog titled "new space". Its hint reads "Starts in ~", or `Starts in ~ on <machine>` when the filter is a remote machine. Submitting a name runs `space.new` with that name, in this computer's `~` (`folder: home()`), or in the filtered machine's home (`machine` and no folder).
- `ctrl-x` on an agent row needs two presses in a row. The first arms it. Any other key, typing, or a chip click disarms it. The second closes the popup and runs `pane.close {pane}`. The navigator asks itself because `pane.close` ends the agent without asking.
- `up` and `down` move the selection and wrap at the ends. The 12-row window follows the selection and keeps it in the middle where it can.
- `ctrl-w` deletes the last word of the query and re-ranks. With an empty query it does nothing.
- `tab` steps the machine filter through all, this computer, and each connected machine. Clicking a chip picks that filter.
- `escape` closes the popup. Each action that leaves (go, new, close, launch) closes the popup first.
- Open spaces show the moment the popup opens. This computer's folders and each remote machine's folders appear as each one answers. A slow machine never holds up the others. Each machine's agent list loads alongside its folders.
- `cmd-enter` on a space row, an agent row, or a folder row opens the agent step without switching. On "New space…" it does nothing, and with the step open it does nothing.
- In the step, `up` and `down` move over the agents and wrap. `enter`, the message field's submit, or a click starts the selected agent, unless it is not installed. `backspace` on an empty message field closes the step and focuses the search field with the query as it was. With text in the field, `backspace` deletes as usual. `escape` closes the popup. The list keys (`alt-enter`, `ctrl-x`, `ctrl-w`) do nothing in the step.
- Starting an agent on a row with a space runs `tab.new {space, name, argv, task?}`. The name is the agent's key, or `<key> 2`, `<key> 3`, and so on when that space already has a tab with the name. On a folder row it runs `space.new {folder, argv, task?, machine?}`. `task` is the trimmed first message and is left out when empty.

## Built from

- One mod, `mods/navigator/`, made of two files: `main.js` and `mod.json`. `mod.json` is `{ "place": "none", "title": "Navigator", "overlay": { "kind": "popup", "at": "top", "offset": 40, "width": 680, "height": 0.8 } }`. `keys.json` binds `"cmd-p": "mod.open:navigator"` in `global`.
- `herdr` functions: `spaces()`, `panes()`, `agents()`, `hc`, `exec`, `run`, `theme()`, `props()`, `openOverlay`, `closeOverlay`, `home()`, and `knownAgents({ on })`.
- gpui functions for `tab`: `cx.bind_keys` binds `tab` to the `navigator.next_scope` action in the `Navigator` context, the root element declares `key_context("Navigator")`, and `on_action("navigator.next_scope", …)` steps the machine filter.
- Mods: the shipped `prompt` mod asks for the new space's name. Navigator passes it `{ title, hint, command: { name: "space.new", args } }`, and `prompt` runs that command with `name` added.
- Programs: `hc machine ls --json` once, keeping machines with `state == "connected"` and not `temporary`. On each machine, it runs `zoxide query -l -s` and `printenv HOME` through `exec(cmd, args, { on: machine })`, and `knownAgents({ on: machine })` in the same task. This computer uses `home()` instead of `printenv`.
- Commands: `space.select {id}`, `space.new {folder, machine?}` (no `machine` for this computer), `space.new {folder: home()}` and `space.new {machine}` through `prompt` for "New space…", `space.close {id}`, `agent.focus {terminal}`, `pane.close {pane}`, and for the agent step `tab.new {space, name, argv, task?}` and `space.new {folder, argv, task?, machine?}`.
- Agent argv: `["sh", "-c", '"$@"; [ $? -eq 0 ] && hc kill "$HC_TERMINAL_ID"', "agent", ...agent.run]`.
- Data: one state per machine (`loading`, `ready` with home and folders, or `error` with a reason). The open-folder index comes from `spaces()` and `panes()`. The ranked rows come from those states, the query, the machine filter, and `agents()`. The ranking is cached and recomputed only when machine data, the query, the filter, the spaces' folders, the agents' identity and titles, or the agent and space statuses change. Every key but `tab` goes through a table from the `keystroke` string to an action, one table for the list and one for the step.
- Agents: `known` maps each machine (null for this computer) to its agents, `{ key, name, run, installed }`. A missing machine is still loading. `LAUNCHABLE = ["claude", "codex", "pi", "omp"]` filters `knownAgents` and keeps its order. When `omp` is absent, `{ key: "omp", name: "omp", run: ["omp"], installed: null }` goes last. When `knownAgents` rejects, the machine gets an empty list.
- Step: `step` is `null` in the list view, or `{ picked, at }` with the ranked row the step opened from and the selected agent index.
- Art: text glyphs only. The spinner cycles `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` with the native `.frames(SPIN, 90)`, never a timer.

## Watch out

- Match open spaces on the terminals' live `cwd`, not on `space.folder`. A space's folder is only where new terminals start, so a space made at home with its shell in `~/projects/app` would otherwise claim the home folder.
- Map each pane to its space through `spaces()[i].tabs`, since `panes()` gives only the tab id.
- Call `zoxide` by name. A hardcoded path breaks on other machines. Each machine's herdr-core needs zoxide on its own `PATH`.
- `exec` rejects when the program cannot start and resolves with a nonzero `code` when it fails. Treat both as an error for that machine, and show the reason in the footer.
- `enter` can reach both the key handler and the input's `submit`. The mod acts on the first one and ignores the rest, so it never makes two spaces.
- A one-agent open row must carry its agent and go there with `agent.focus`. `space.select` restores the space's last tab, which may not be the agent's tab.
- herdr-app draws nothing for an SVG reached through a symlink. home-manager and stow install every file as a symlink, so the mod draws text glyphs instead of `svg()` icons.
- Paint the selected row with `selected`, not `hover`. A theme may set `hover` equal to `popover` (both Rosé Pine themes do), and the selection would vanish against the popup.
- `tab` is a GPUI focus-next binding, and it runs before `on_key_down`, so a key handler never sees it and the input loses focus. Navigator binds `tab` in its own `Navigator` key context and handles it with `on_action`. The app keymap has no unbind and `init` runs on every open, so Navigator binds once per app run behind a `globalThis` flag.
- Selection is an index. It resets to the top when the query or the filter changes. A machine that answers late can reorder the list under the selection, and so can a status change.
- `ctrl-w` deletes the query's last word, not the word before a moved caret: `InputState` exposes no caret position, and `set_value` puts the caret back at the end. `set_value` also emits no change event, so `deleteWord` updates the query and ranking itself.
- Machines come from one `hc machine ls` call when the popup opens. A machine that connects while the popup is open shows up the next time it opens.
- The search `InputState` fires `submit` for `cmd-enter` too, with `event.secondary` set. Route a secondary submit to the step, or `cmd-enter` switches spaces. The `cmd-enter` key entry stays as well, and opening the step is a no-op when it is already open, so whichever fires first wins.
- herdr runs `argv` inside the person's interactive shell, which outlives the agent. Without the `sh -c … hc kill` wrapper, quitting the agent leaves a shell in the tab.
- herdr's built-in program table lacks `omp`, so `knownAgents` lists it only when a `programs.json` entry adds it. `omp` still runs from `argv` and reports as `app: "omp"`, so Navigator adds it with `installed: null` when it is missing.
- When the agent's tab is its space's only tab, `hc kill` closes the whole space without asking.
- herdr closes a popup on Esc before the mod sees the key, so `escape` in the step cannot go back. The step goes back with `backspace` on an empty message field, and `escape` closes the popup. A step action returns `false` to let a key through, as `backspace` does when the field has text.

## Done when

- `herdr-app check mods/navigator` passes.
- With a space whose terminal sits in a zoxide folder, typing part of that folder's name puts an open row ("go to") at the top. Enter switches to that space.
- With an empty query, a working agent's row sits above a blocked one, which sits above done, idle, then a space with no agent.
- Enter on a folder row makes a new space in that folder, on that row's machine.
- `alt-enter` on an open row makes a second space in the same folder.
- Picking "New space…" asks for a name and makes a space with that name in `~`, or in the filtered machine's home when the filter is a remote machine. `ctrl-x` on it does nothing. A query that matches nothing reads `0` and still shows "New space…".
- `ctrl-x` on an open row asks to close that space.
- In the search field, `ctrl-w` after `code api` leaves `code `, after one word leaves the field empty, and with an empty field does nothing.
- With a space holding two agents, one of them idle, the list shows two `space › tab` rows with their own glyphs. Enter goes to that agent's tab. `ctrl-x` once shows the prompt, and twice closes only that agent's pane.
- With a space holding one agent whose title names a task, its row shows `app  task` instead of the path, and typing a word of its folder still finds it. With an idle Claude Code, whose title is only its name, the row shows `claude-code`.
- With a space holding several tabs and one agent, select an empty tab, then switch to another space. Enter on that space's row opens the agent's tab.
- With a remote machine connected, its folders appear with its chip. Typing the machine's name narrows to its rows, and `tab` cycles all, this computer, and the machine.
- On a machine without zoxide, the footer names it with the reason, and its open spaces still show.
- `cmd-enter` on a space row opens the agent step and does not switch spaces.
- Picking `claude` in the step with a first message adds a tab named `claude` to that space, and Claude receives the message.
- Launching `claude` again in the same space makes a tab named `claude 2`.
- Quitting an agent closes its tab. An agent that exits with an error keeps its tab and output.
- `backspace` on an empty message field in the step returns to the list with the query intact.
- `escape` in the step closes the popup.
