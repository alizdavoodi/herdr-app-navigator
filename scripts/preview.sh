#!/bin/sh
# Makes preview.png and preview.gif from a herdr-app window that shows only demo data.
#
#   scripts/preview.sh up     make the demo home and open its window
#   scripts/preview.sh png    open Navigator there and save preview.png
#   scripts/preview.sh gif    record preview.gif (10 s, or $SECONDS_TO_RECORD); on macOS it types the demo itself
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
	env HOME="$demo/home" HERDR_APP_HOME="$app" HC_SESSION=navdemo \
		XDG_CONFIG_HOME="$demo/xdg/config" XDG_STATE_HOME="$demo/xdg/state" \
		_ZO_DATA_DIR="$demo/zoxide/local" "$@"
}

devbox_env() {
	env HOME="$demo/devbox" HC_SESSION=navdemo-devbox \
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

# crop <frame.png> <out.png> [height]: cut the popup out of a window frame, scaled to 748 px wide.
# With a height, pad below the popup to that height in the color just above it, so the window
# behind a shrinking popup stays out of the picture. Prints the output height.
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
	if [ -n "${3:-}" ]; then
		magick "$2" -background "$(magick "$2" -format '%[pixel:p{0,0}]' info:)" -gravity north -extent "748x$3" "$2"
	fi
	magick identify -format %h "$2"
}

up() {
	if [ -f "$demo/app.pid" ] && kill -0 "$(cat "$demo/app.pid")" 2>/dev/null; then
		echo "The demo window is already open. Run '$0 down' first." >&2
		exit 1
	fi
	rm -rf "$demo"
	mkdir -p "$app/mods/navigator" "$app/themes" "$demo/xdg/config" "$demo/xdg/state" \
		"$demo/devbox-xdg/config" "$demo/devbox-xdg/state" "$demo/zoxide/local" "$demo/zoxide/devbox" "$demo/bin"

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

	via="env HOME=$demo/devbox _ZO_DATA_DIR=$demo/zoxide/devbox XDG_CONFIG_HOME=$demo/devbox-xdg/config XDG_STATE_HOME=$demo/devbox-xdg/state sh -c"
	local_env hc machine add --name devbox --session navdemo-devbox --via "$via" >/dev/null
	tries=0
	until local_env hc machine ls --json | grep -q '"state":"connected"'; do
		tries=$((tries + 1))
		[ $tries -lt 60 ] || { echo "devbox did not connect" >&2; exit 1; }
		sleep 0.5
	done

	local_env herdr-app do app.theme --name atom-one-dark >/dev/null
	local_env herdr-app do space.new --folder "$demo/home/code/api" \
		--argv "[\"$demo/bin/demo-agent\", \"working\", \"claude-code\", \"Add rate limiting to the login route\"]" >/dev/null
	local_env herdr-app do space.new --folder "$demo/home/code/web" \
		--argv "[\"$demo/bin/demo-agent\", \"idle\", \"codex\", \"codex\"]" >/dev/null
	local_env herdr-app do space.new --machine devbox --folder "$demo/devbox/code/ml-pipeline" >/dev/null
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

# drive: types the demo into Navigator. Every key first checks that the demo window is still in
# front and stops otherwise, so no keystroke reaches another app.
drive() {
	osascript - "$(cat "$demo/app.pid")" <<-'EOF'
		on guard(demoPid)
			tell application "System Events"
				if unix id of (first process whose frontmost is true) is not demoPid then error "the demo window lost focus"
			end tell
		end guard
		on press(demoPid, k)
			my guard(demoPid)
			tell application "System Events" to key code k
		end press
		on typeText(demoPid, t)
			repeat with c in characters of t
				my guard(demoPid)
				tell application "System Events" to keystroke (c as text)
				delay 0.3
			end repeat
		end typeText
		on run argv
			set p to (item 1 of argv) as integer
			delay 1.5
			my typeText(p, "api")
			delay 1.2
			my press(p, 125) -- down
			delay 0.8
			my press(p, 125)
			delay 0.8
			repeat 3 times
				my press(p, 51) -- delete
				delay 0.15
			end repeat
			delay 0.8
			my press(p, 48) -- tab: this computer
			delay 1.2
			my press(p, 48) -- tab: devbox
			delay 1.2
			my press(p, 48) -- tab: all machines
		end run
	EOF
}

gif() {
	out=${1:-$repo/preview.gif}
	seconds=${SECONDS_TO_RECORD:-10}
	rm -rf "$demo/frames"
	mkdir -p "$demo/frames"
	front
	open_navigator
	if [ "$(uname)" = Darwin ]; then
		echo "Recording for $seconds s. Don't touch the keyboard: the script types the demo."
		drive &
		driver=$!
	else
		echo "Recording for $seconds s. Type in the Navigator window now."
	fi
	start=$(date +%s)
	n=0
	while [ $(($(date +%s) - start)) -lt "$seconds" ]; do
		n=$((n + 1))
		local_env herdr-app shot "$(printf '%s/frames/%05d.png' "$demo" "$n")" >/dev/null
		sleep 0.05
	done
	if [ -n "${driver:-}" ] && ! wait "$driver"; then
		echo "Typing stopped early, so the recording is incomplete. Run '$0 gif' again." >&2
		exit 1
	fi
	fps=$(awk "BEGIN { f = $n / $seconds; print (f < 1 ? 1 : f) }")
	h=$(crop "$demo/frames/00001.png" "$demo/frames/00001.png")
	for f in "$demo"/frames/*.png; do
		[ "$f" = "$demo/frames/00001.png" ] || crop "$f" "$f" "$h" >/dev/null
	done
	gifski --quiet --fps "$fps" --width 748 --output "$out" "$demo"/frames/*.png
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
	sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
