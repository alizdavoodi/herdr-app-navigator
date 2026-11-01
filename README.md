# herdr-app-navigator

`navigator` is a mod for [herdr-app](https://herdr.dev), the Herdr desktop app. Press `cmd-p`, type a few letters of a folder, and press Enter. If a space already has a terminal in that folder, Navigator goes to it. If not, Navigator makes a new space there. The list holds the [zoxide](https://github.com/ajeetdsouza/zoxide) folders of this computer and of every machine connected to herdr-core, so a folder on a remote box is as close as a local one.

![Navigator](preview.png)

## Install

1. The mod is two files, `main.js` and `mod.json`. Copy the mod folder into your herdr-app home:

	```sh
	cp -R mods/navigator ~/.config/herdr-app/mods/
	```

	Symlinking the two files works too, so home-manager and stow installs are fine. Link the files, not the folder, because herdr-app writes `jsconfig.json` and `gpui-kit.d.ts` into every mod folder.

2. Merge `keys.json` into `~/.config/herdr-app/keys.json`. It binds `cmd-p` in the `global` section to `mod.open:navigator`. If `cmd-p` already does something for you (the shipped picker, for example), decide which one keeps it.
3. Check that the mod loads:

	```sh
	herdr-app check ~/.config/herdr-app/mods/navigator
	```

The mod runs programs. It calls `hc machine ls --json` to find machines, and `zoxide query -l -s` and `printenv HOME` on each one. It reads no files and makes no network requests of its own.

## Requirements

- zoxide on every machine whose folders you want in the list. It has to be on the `PATH` that herdr-app sees on this computer and that herdr-core sees on each remote machine. Navigator calls `zoxide` by name and never guesses an install path. A machine without it shows an error line in the footer, and its open spaces still appear.
- herdr-app with herdr-core (`hc`).

## Keys

| Key | What it does |
| --- | --- |
| `cmd-p` | Opens Navigator (from `keys.json`). |
| Type | Filters the list. Each word you type has to match. |
| `up`, `down` | Moves the selection. It wraps at both ends. |
| `enter` or click | Goes to the open space or the agent's tab, or makes a new space in the folder. On the last row, "New space…", it asks for a name and makes a space in `~`, on the filtered machine when one is selected. |
| `alt-enter` | Makes a new space in the folder even when one is open there. |
| `ctrl-x` | Closes the selected open space, and the app asks you to confirm. On an agent row it asks for a second `ctrl-x`, then closes that agent's pane. Other agents in the same tab keep running. |
| `tab` | Switches the machine filter: all, this computer, then each connected machine. |
| `escape` | Closes Navigator. |

A space with two or more agents shows one row per agent instead of one row for the space, labelled `space › tab` with that agent's status and title, so an idle agent next to busy ones stays visible. A space with one agent keeps its single row but shows that agent's app and title in place of the path, or just the app when the title is empty or only names the app. Open spaces and agents list working first, then waiting for you, done, idle, and spaces with no agent.

## How remote machines work

herdr-core reaches other machines over ssh. Add one with:

```sh
hc machine add vps
```

Every machine that `hc machine ls` reports as connected appears in Navigator, except machines added with `--temp`. Navigator runs zoxide there through herdr-core, shows that machine's folders with a chip naming it, and makes new spaces on it with `space.new {folder, machine}`. Each machine loads on its own. Open spaces show at once, and each machine's folders appear when it answers.

## Credit

The idea comes from [thanhdat77/herdr-navigator](https://github.com/thanhdat77/herdr-navigator), a folder-to-space navigator for the Herdr terminal UI. This repo is a separate implementation for herdr-app.

## License

MIT. See [LICENSE](LICENSE).
