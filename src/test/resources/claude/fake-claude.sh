#!/usr/bin/env bash
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  [ -n "$FAKE_AUTH_SLEEP" ] && sleep "$FAKE_AUTH_SLEEP"
  if [ -n "$FAKE_AUTH_JSON" ]; then printf '%s\n' "$FAKE_AUTH_JSON"; else echo '{}'; fi
  exit "${FAKE_AUTH_EXIT:-0}"
fi
if [ -n "$FAKE_RECORD" ]; then
  mkdir -p "$FAKE_RECORD"
  n=$(cat "$FAKE_RECORD/count" 2>/dev/null || echo 0)
  n=$((n+1)); echo "$n" > "$FAKE_RECORD/count"
  for a in "$@"; do printf '[%s]\n' "$a"; done > "$FAKE_RECORD/argv-$n"
  cat > "$FAKE_RECORD/stdin-$n"
  pwd > "$FAKE_RECORD/pwd-$n"
  env | sort > "$FAKE_RECORD/env-$n"
  sysfile=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--system-prompt-file" ]; then sysfile="$a"; fi
    prev="$a"
  done
  [ -n "$sysfile" ] && cp "$sysfile" "$FAKE_RECORD/sysprompt-$n"
else
  cat >/dev/null
fi
[ -n "$FAKE_CHILD" ] && sleep 300 &
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
[ -n "$FAKE_STDERR" ] && printf '%s\n' "$FAKE_STDERR" >&2
if [ -n "$FAKE_FIXTURE_DIR" ]; then
  n=$(cat "$FAKE_RECORD/count" 2>/dev/null || echo 1)
  cat "$FAKE_FIXTURE_DIR/$n.json" 2>/dev/null || cat "$FAKE_FIXTURE_DIR/last.json" 2>/dev/null
elif [ -n "$FAKE_FIXTURE" ]; then
  cat "$FAKE_FIXTURE"
fi
exit "${FAKE_EXIT:-0}"
