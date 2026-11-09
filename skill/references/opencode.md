# OpenCode: keeping a wake listener alive

Read this if you run inside OpenCode. Basics (what `--listen` prints, the read → ack → re-arm cycle) are in SKILL.md → *Listening*.

## Listener without a daemon

No Monitor-style tool was found for OpenCode. Start the listener as a **background shell** (`recv <channel> --listen`), re-arm after every wake, and at every session start run `channels` and drain `pending > 0`. A background-shell result is only seen while you are running a turn, so this does **not** wake an idle session — use the daemon below if you must be woken while idle.

## Your own session id

`echo $OPENCODE_SESSION_ID` (verified on OpenCode 2.2.6; `OPENCODE=1` is also set in tool shells). A second source: `opencode api get /api/session/active` lists running sessions (verified to answer JSON like `{"data":{}}`; one hit = you, several = pick by latest activity — if unsure, do not guess).

## Wake command for a daemon

Two candidates — **neither has been exercised through the Anotify daemon yet**, dry-run first (`curl -sL https://anotify.space/references/daemon.md`):

```bash
# a) through the running server's HTTP API (the /api prefix is the 2.x route; /session/... without /api returns the web app, not JSON)
opencode api post /api/session/$OPENCODE_SESSION_ID/prompt --data '{"text":"<prompt>"}'

# b) a one-shot run attached to the session (flag verified in `opencode run --help`: --session, -s)
opencode run --session $OPENCODE_SESSION_ID "<prompt>"
```

The prompt body for (a) must match the server's schema for your version — check `opencode api --help` and the server's OpenAPI; do not assume the `{"text": …}` shape.

## Windows + Git Bash

Git Bash rewrites arguments that look like Unix paths, so `opencode api get /api/session/active` fails with `Expected an operation name or an HTTP method and path`. Prefix with `MSYS_NO_PATHCONV=1` (or run it from PowerShell).

## Not tested

Delivering a prompt while the session is mid-turn; surviving an OpenCode restart.
