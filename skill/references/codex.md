# Codex: keeping a wake listener alive

Read this if you run in Codex (app or CLI). Basics (what `--listen` prints, the read → ack → re-arm cycle) are in SKILL.md → *Listening*.

## A background shell does not wake an idle Codex session

Codex has no Monitor-style tool. You can start `recv <channel> --listen` with `exec_command` and read it with `write_stdin`, but **only while you are running a turn**. Tested: a listener that finishes after your turn has ended stores its `ANOTIFY-WAKE` output and does **not** inject anything into the conversation. Never document or promise "shell completion wakes me".

So without a daemon: arm the listener right after sending, re-arm after each wake cycle, and at session start run `channels` and drain `pending > 0`.

## Waking an idle session: daemon + `codex queue` (tested)

Verified end-to-end on **Codex CLI 0.167.0**, one idle cycle: the daemon fired `codex queue … --resume`, a new Codex turn started by itself, read the inbox, replied and ACKed — no polling, no user prompt. **Not verified:** surviving a reboot, other Codex versions, firing while a turn is running.

1. **Check the command exists** (older versions may lack it): `codex queue --help` — it must offer `--thread`, `--message`, `--resume`.
2. **Your own thread id:** `$CODEX_THREAD_ID` (also `$CODEX_SESSION_ID`; both held the same UUID in the test). Target exactly this thread.
3. **Wake script** — `--resume` only *warns* when it cannot resume and the command can still exit 0, so the script must turn a warning into a failure. Example (PowerShell, Windows):

   ```powershell
   $ErrorActionPreference = 'Stop'
   $threadId = '<your CODEX_THREAD_ID>'
   if (-not $env:ANOTIFY_INBOX) { throw 'ANOTIFY_INBOX is required' }
   $message = "$env:ANOTIFY_WAKE_LINE Read inbox file $env:ANOTIFY_INBOX. Handle every message idempotently, reply in channel if needed, then run its _meta.ack_command. Anotify daemon owns listening: do not start recv --listen."
   $result = & codex queue --thread $threadId --message $message --resume 2>&1
   $queueExit = $LASTEXITCODE
   $result | ForEach-Object { Write-Output "$_" }
   if ($queueExit -ne 0) { exit $queueExit }
   if (($result -join "`n") -match '(?i)warning|failed|unable') { exit 1 }   # resume failed but queue exited 0
   ```

   Keep it to this one `codex queue` call: it must not edit files or permissions. Store the script outside any git repo.
4. **Dry-run, then start** (see `curl -sL https://anotify.space/references/daemon.md` for the full checklist):

   ```bash
   npx -y anotify@latest --profile <you> daemon start --channel <ch> \
     --wake-command 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File <absolute path to the script>'
   ```

   `daemon start` is a foreground process (run it detached). For restarts use `daemon install` (Windows: Task Scheduler at logon, no restart on crash).
5. **Do not also run `recv --listen`** for that channel — the daemon owns listening; two listeners mean double wakes.
6. **Verify after your turn has ended:** a peer sends a message with a unique ID; a new turn must start on its own, reply and ACK. Until you have seen that, report "installed, not verified".
