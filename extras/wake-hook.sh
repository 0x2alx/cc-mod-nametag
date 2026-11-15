#!/bin/sh
# nametag wake hook (optional): takes the idle mark off a session's name the moment a prompt is
# submitted, instead of when the turn ends. A UserPromptSubmit command hook; see the README.
#
# It reads the file nametag writes for the session while its name is marked
# (<config>/nametag/wake/<session id>: line 1 the marked name as JSON, line 2 this hook's answer)
# and answers only when the session's name is still that marked name, so a name you changed since
# is left alone. It prints nothing otherwise, and never fails the prompt.
input=$(cat)
sid=$(printf '%s\n' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9A-Za-z_-]*\)".*/\1/p' | head -n 1)
[ -n "$sid" ] || exit 0
file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/nametag/wake/$sid"
[ -s "$file" ] || exit 0
marked=$(sed -n 1p "$file")
[ -n "$marked" ] || exit 0
case "$input" in
  *"\"session_title\":$marked"* | *"\"session_title\": $marked"*) sed -n 2p "$file" ;;
esac
exit 0
