#!/bin/sh
# Makes preview.png (the Navigator popup) and preview.gif (the whole window) from a herdr-app
# window that shows only demo data.
#
#   scripts/preview.sh up     make the demo home and open its window
#   scripts/preview.sh png    open Navigator there and save preview.png
#   scripts/preview.sh gif    record preview.gif (10 s, or $SECONDS_TO_RECORD); on macOS it types and clicks itself
#   scripts/preview.sh down   close the window, stop its cores, delete the demo home
#
# The window has its own herdr-app home, herdr-core sessions, HOME, and zoxide database, so
# none of your spaces, machines, or folders appear. "devbox" is a second core on this computer.
# Needs herdr-app, hc, zoxide, magick (ImageMagick), oxipng, gifski, and exiftool on PATH:
#   nix shell nixpkgs#imagemagick nixpkgs#oxipng nixpkgs#gifski nixpkgs#exiftool
# The window must be in front while it is captured, because it draws no frames while hidden.
# On macOS the script brings it there with osascript.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd -P)
# hc keeps its sockets under the demo home, and a socket path must stay under 104 bytes.
base=${NAVDEMO_DIR:-/tmp/hnav-demo}
mkdir -p "$base"
demo=$(cd "$base" && pwd -P)
app="$demo/app"
win_w=1100
win_h=900
zoom=1.1

local_env() {
	env HOME="$demo/home" HERDR_APP_HOME="$app" HC_SESSION=navdemo ENV="$demo/home/.profile" \
		XDG_CONFIG_HOME="$demo/xdg/config" XDG_STATE_HOME="$demo/xdg/state" \
		_ZO_DATA_DIR="$demo/zoxide/local" "$@"
}

devbox_env() {
	env HOME="$demo/devbox" HC_SESSION=navdemo-devbox ENV="$demo/devbox/.profile" \
		XDG_CONFIG_HOME="$demo/devbox-xdg/config" XDG_STATE_HOME="$demo/devbox-xdg/state" \
		_ZO_DATA_DIR="$demo/zoxide/devbox" "$@"
}

# folder <home> <zoxide dir> <rank> <path under home>
folder() {
	mkdir -p "$1/$4"
	env _ZO_DATA_DIR="$2" zoxide add --score "$3" "$1/$4"
}

front() {
	pid=$(cat "$demo/app.pid")
	if [ "$(uname)" = Darwin ]; then
		osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $pid) to true" >/dev/null ||
			echo "Bring the demo window to the front, then run this again." >&2
	fi
	sleep 1
}

open_navigator() {
	local_env herdr-app do overlay.close >/dev/null 2>&1 || true
	local_env herdr-app do mod.open --name navigator >/dev/null
	sleep 3
}

# crop <frame.png> <out.png>: cut the popup out of a window frame, scaled to 748 px wide.
crop() {
	frame_w=$(magick identify -format %w "$1")
	scale=$(awk "BEGIN { print $frame_w / $win_w }")
	popup_w=$(awk "BEGIN { printf \"%d\", 680 * $zoom * $scale + 0.5 }")
	x=$(awk "BEGIN { printf \"%d\", ($frame_w - $popup_w) / 2 }")
	top=$(awk "BEGIN { printf \"%d\", 40 * $zoom * $scale }")
	# Walk down the popup's left padding until the color changes: that row is its bottom border.
	col=$((x + 15))
	bottom=$(magick "$1" -crop "1x100000+$col+$((top + 2))" +repage -depth 8 txt:- |
		awk 'NR > 1 { split($0, at, /[,:]/); match($0, /#[0-9A-Fa-f]+/); hex = substr($0, RSTART, RLENGTH) }
			NR == 2 { first = hex } NR > 2 && hex != first { print at[2]; exit }')
	magick "$1" -crop "${popup_w}x$((bottom + 4))+$x+$((top - 1))" +repage "$2"
	[ "$popup_w" -eq 748 ] || magick "$2" -resize 748x "$2"
}

up() {
	if [ -f "$demo/app.pid" ] && kill -0 "$(cat "$demo/app.pid")" 2>/dev/null; then
		echo "The demo window is already open. Run '$0 down' first." >&2
		exit 1
	fi
	rm -rf "$demo"
	mkdir -p "$app/mods/navigator" "$app/themes" "$demo/xdg/config/herdr-core" "$demo/xdg/state" \
		"$demo/devbox-xdg/config/herdr-core" "$demo/devbox-xdg/state" "$demo/zoxide/local" "$demo/zoxide/devbox" \
		"$demo/bin" "$demo/home" "$demo/devbox"

	# New terminals run plain sh with a prompt that shows only the folder. Your login shell's
	# prompt (and macOS's /etc/bashrc) would show your user and host name.
	for core in xdg devbox-xdg; do
		printf 'shell = ["/bin/sh"]\n' >"$demo/$core/config/herdr-core/config.toml"
	done
	for h in home devbox; do
		printf "PS1='\\\\w \\\\$ '\nexport PS1\n" >"$demo/$h/.profile"
	done

	cp "$repo/mods/navigator/main.js" "$repo/mods/navigator/mod.json" "$app/mods/navigator/"
	cp "$repo/keys.json" "$app/keys.json"
	printf '{ "zoom": %s, "appearance": "dark" }\n' "$zoom" >"$app/settings.json"
	printf '{ "frame.welcomed": "finished" }\n' >"$app/shared.json"
	printf '{ "state": "windowed", "bounds": [80.0, 80.0, %s.0, %s.0] }\n' "$win_w" "$win_h" >"$app/window.json"
	printf '{ "last_run": "%s", "presented": [] }\n' "$(herdr-app --version | awk '{ print $2 }')" >"$app/update-notes.json"
	cat >"$app/themes/atom-one-dark.json" <<-'EOF'
		{
		  "background": "#21252b",
		  "foreground": "#abb2bf",
		  "selection": "#323844",
		  "cursor": "#abb2bf",
		  "ansi": [
		    "#454c59", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
		    "#767676", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf"
		  ]
		}
	EOF

	# An agent is any program that reports a status with OSC 7501. This one reports once and waits.
	cat >"$demo/bin/demo-agent" <<-'EOF'
		#!/bin/sh
		printf '\033]7501;:state=%s:app=%s\007' "$1" "$2"
		[ -n "${3:-}" ] && printf '\033]2;%s\007' "$3"
		exec sleep 86400
	EOF
	chmod +x "$demo/bin/demo-agent"

	h="$demo/home"
	z="$demo/zoxide/local"
	folder "$h" "$z" 40 code/api
	folder "$h" "$z" 35 code/web
	folder "$h" "$z" 30 code/dotfiles
	folder "$h" "$z" 25 code/infra
	folder "$h" "$z" 20 code/infra/staging
	folder "$h" "$z" 15 code/docs
	folder "$h" "$z" 12 code/cli
	folder "$h" "$z" 10 notes
	folder "$h" "$z" 8 code/mobile
	folder "$h" "$z" 6 code/infra/production
	folder "$h" "$z" 4 scratch
	h="$demo/devbox"
	z="$demo/zoxide/devbox"
	folder "$h" "$z" 30 code/ml-pipeline
	folder "$h" "$z" 18 data
	folder "$h" "$z" 14 code/api
	folder "$h" "$z" 9 logs

	# $! would be the pid of a subshell, so the launched shell writes its own pid before exec.
	local_env nohup sh -c 'echo $$ >"$1"; exec herdr-app' sh "$demo/app.pid" >"$demo/app.log" 2>&1 &
	tries=0
	until local_env herdr-app status >/dev/null 2>&1; do
		tries=$((tries + 1))
		[ $tries -lt 60 ] || { echo "herdr-app did not start; see $demo/app.log" >&2; exit 1; }
		sleep 0.5
	done

	via="env HOME=$demo/devbox ENV=$demo/devbox/.profile _ZO_DATA_DIR=$demo/zoxide/devbox XDG_CONFIG_HOME=$demo/devbox-xdg/config XDG_STATE_HOME=$demo/devbox-xdg/state sh -c"
	local_env hc machine add --name devbox --session navdemo-devbox --via "$via" >/dev/null
	tries=0
	until local_env hc machine ls --json | grep -q '"state":"connected"'; do
		tries=$((tries + 1))
		[ $tries -lt 60 ] || { echo "devbox did not connect" >&2; exit 1; }
		sleep 0.5
	done

	local_env herdr-app do app.theme --name atom-one-dark >/dev/null
	api=$(local_env herdr-app do space.new --folder "$demo/home/code/api" \
		--argv "[\"$demo/bin/demo-agent\", \"working\", \"claude-code\", \"Add rate limiting to the login route\"]" |
		sed -n 's/.*"space": *"\([^"]*\)".*/\1/p')
	local_env herdr-app do space.new --folder "$demo/home/code/web" \
		--argv "[\"$demo/bin/demo-agent\", \"idle\", \"codex\", \"codex\"]" >/dev/null
	local_env herdr-app do space.new --machine devbox --folder "$demo/devbox/code/ml-pipeline" >/dev/null
	# Start on the agent's space: its terminal is empty, so the window shows no shell output.
	local_env herdr-app do space.select --id "$api" >/dev/null
	echo "Demo window is up. Next: '$0 png' or '$0 gif'."
}

png() {
	out=${1:-$repo/preview.png}
	front
	open_navigator
	local_env herdr-app shot "$demo/frame.png" >/dev/null
	crop "$demo/frame.png" "$out" >/dev/null
	oxipng --quiet --opt max --strip all "$out"
	echo "$out"
}

# Where the folder row's "new" label sits in the window when it is the top row, in points:
# centered 680 * zoom popup, 40 * zoom below the top, then padding, chips, search field, half a row.
new_x=854
new_y=163

# drive: types "dotf" into Navigator, moves the pointer to the dotfiles row's "new" label, and
# clicks it. Before every key and mouse event it checks that the demo window is still in front
# and stops otherwise, so no input reaches another app. Each pointer position, relative to the
# window, goes to $demo/pointer, because herdr-app shot does not draw the system cursor.
drive() {
	osascript -l JavaScript - "$(cat "$demo/app.pid")" "$demo/pointer" "$new_x" "$new_y" <<-'EOF'
		ObjC.import('Foundation');
		ObjC.import('CoreGraphics');
		function run(argv) {
			const pointerFile = argv[1];
			const target = { x: Number(argv[2]), y: Number(argv[3]) };
			const se = Application('System Events');
			const proc = se.processes.whose({ unixId: Number(argv[0]) })[0];
			const guard = () => {
				if (!proc.frontmost()) throw new Error('the demo window lost focus');
			};
			const [wx, wy] = proc.windows[0].position();
			// CGEvent types: 5 moved, 1 left button down, 2 left button up.
			const mouse = (type, p) => {
				guard();
				$.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, { x: wx + p.x, y: wy + p.y }, 0));
				$(`${Math.round(p.x)} ${Math.round(p.y)}`).writeToFileAtomicallyEncodingError(pointerFile, true, $.NSUTF8StringEncoding, null);
			};
			const start = { x: 1000, y: 700 };
			mouse(5, start);
			delay(1.5);
			for (const c of 'dotf') {
				guard();
				se.keystroke(c);
				delay(0.3);
			}
			delay(1.2);
			for (let i = 1; i <= 15; i++) {
				const t = i / 15;
				const ease = t * t * (3 - 2 * t);
				mouse(5, { x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease });
				delay(0.05);
			}
			delay(0.8);
			mouse(1, target);
			delay(0.08);
			mouse(2, target);
			delay(3);
		}
	EOF
}

gif() {
	out=${1:-$repo/preview.gif}
	seconds=${SECONDS_TO_RECORD:-10}
	rm -rf "$demo/frames" "$demo/pointer" "$demo/pointer.log"
	mkdir -p "$demo/frames"
	touch "$demo/pointer.log"
	front
	open_navigator
	if [ "$(uname)" = Darwin ]; then
		echo "Recording for $seconds s. Don't touch the keyboard or mouse: the script types and clicks."
		drive &
		driver=$!
	else
		echo "Recording for $seconds s. Type a folder name in Navigator, then click its row."
	fi
	start=$(date +%s)
	n=0
	while [ $(($(date +%s) - start)) -lt "$seconds" ]; do
		n=$((n + 1))
		local_env herdr-app shot "$(printf '%s/frames/%05d.png' "$demo" "$n")" >/dev/null
		[ ! -f "$demo/pointer" ] || echo "$n $(cat "$demo/pointer")" >>"$demo/pointer.log"
		sleep 0.05
	done
	if [ -n "${driver:-}" ] && ! wait "$driver"; then
		echo "The scripted input stopped early, so the recording is incomplete. Run '$0 gif' again." >&2
		exit 1
	fi
	fps=$(awk "BEGIN { f = $n / $seconds; print (f < 1 ? 1 : f) }")
	n=0
	for f in "$demo"/frames/*.png; do
		n=$((n + 1))
		[ "$(magick identify -format %w "$f")" -eq "$win_w" ] || magick "$f" -resize "${win_w}x" "$f"
		at=$(awk -v n="$n" '$1 == n { print $2 "," $3 }' "$demo/pointer.log")
		[ -z "$at" ] || magick "$f" -fill white -stroke black -strokewidth 1 \
			-draw "translate $at polygon 0,0 0,17 4,13 7,20 10,19 7,12 12,12" "$f"
	done
	gifski --quiet --fps "$fps" --width "$win_w" --output "$out" "$demo"/frames/*.png
	exiftool -quiet -overwrite_original -all= "$out"
	echo "$out ($n frames at $fps fps)"
}

down() {
	if [ -f "$demo/app.pid" ]; then
		kill "$(cat "$demo/app.pid")" 2>/dev/null || true
	fi
	local_env hc server stop >/dev/null 2>&1 || true
	devbox_env hc server stop >/dev/null 2>&1 || true
	# Terminal holders outlive "server stop"; their socket paths sit inside the demo home.
	pkill -f "$demo/" 2>/dev/null || true
	rm -rf "$demo"
}

case "${1:-}" in
up) up ;;
png) png "${2:-}" ;;
gif) gif "${2:-}" ;;
down) down ;;
*)
	sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
