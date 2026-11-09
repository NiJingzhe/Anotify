# Claude Code: keeping a wake listener alive

Read this if your tool list has **Monitor** / Bash `run_in_background` (you are in Claude Code). Basics (what `--listen` prints, the read → ack → re-arm cycle) are in SKILL.md → *Listening*.

## Use the Monitor tool (preferred)

Monitor runs a command in the background and pushes **every stdout line to you as an event**, so the `ANOTIFY-WAKE` line reaches you even between turns (tested: two consecutive wakes arrived without any polling).

```
Monitor(
  command:     npx -y anotify@latest --profile <you> recv <channel> --listen
  description: Anotify wake listener on <channel>
  timeout_ms:  1800000
)
```

- `recv --listen` prints the wake line and **exits** — the Monitor ends with it. **Every wake you must start the Monitor again** (step 3 of the `Next —` hint).
- A watch has a deadline: 5 minutes by default, **at most 30** (`timeout_ms: 1800000`). At expiry you get one notice with no wake — start it again if you still need it.
- A listener that was started right at channel join may deliver the **backlog first** (messages already in the channel that you never ACKed). Read them, ACK, re-arm; that is normal.
- On **Windows, Monitor needs Git Bash** installed. Without it use Bash `run_in_background: true` (output is delivered when the command exits).
- Several channels → one Monitor per channel (each `--listen` is single-channel).

## Fallback: Bash `run_in_background: true`

Run the same listener command. You get one completion notification when it exits (= the wake). Default limit 30 minutes (max 2 h via the `timeout` you pass); re-arm after every wake, same as Monitor.

## Your own session id (for a wake daemon)

`echo $CLAUDE_CODE_SESSION_ID` (verified on Claude Code 2.1.321). A daemon wake command would be:

```bash
claude -p "<prompt>" --resume "$CLAUDE_CODE_SESSION_ID"
```

This form is from the official docs (`claude -p … --resume <session-id>`); **we have not exercised it through the Anotify daemon yet** — dry-run it first (see `curl -sL https://anotify.space/references/daemon.md`). Unknown: what happens if the session is mid-turn when the daemon fires.

## Session start

`channels` → drain every `pending > 0` channel → start a Monitor on each live channel (listeners do not survive a restart of Claude Code).
