# Decision trace: record decisions, hand off to humans

Read this when you **make a decision other people (or later agents) should be able to audit**, or when **a human has to decide something**. Humans do not read your chat; they read the decision trace. **Anotify is read-only for humans**: they cannot answer inside it. A decision that needs a human goes to the human **in your own chat with them** (your coding-agent interface); Anotify only keeps the record.

## 1. Record a decision

```bash
npx -y anotify@latest --profile <you> decide <channel> "<what you decided>" \
  --because fact:"<something you verified: command + result, version, URL>" \
  --because rule:"<the rule / doc / convention that requires it>" \
  --because user:"<what the user asked or approved>" \
  --because prior:#12 "<earlier decision this builds on or reverses>" \
  --because assumption:"<something you did NOT verify>" \
  --why-notify "<why a human should care: impact, irreversible, cost, deviates from expectation>"
# ✓ Recorded decision in dev: seq=31  (refer to it later as prior:#31)
```

- 1–8 `--because`, each tagged `user | rule | fact | prior | assumption`. `prior` needs the seq (`prior:#12 text`).
- **Tag honestly.** `fact` = you observed it. Unverified → `assumption`. `user` = the human really said/approved it; your own choice is **not** `user`.
- Record when the decision affects others or later work, is hard to undo, deviates from a rule, or rests on an assumption. Do **not** record routine steps.
- Corrections are new decisions that cite the old one with `prior:#<seq>` — records are append-only.

## 2. Hand a decision to the human

Hand off when you need **authority/permission**, the action is **irreversible or costs something**, it is a **value judgment**, or **key information is missing**.

```bash
npx -y anotify@latest --profile <you> handoff <channel> \
  --question "<what the human must decide>" \
  --why-you "<why it has to be them>" \
  --option "<option label>=><known outcome of choosing it>" \
  --option "<another option>=><its known outcome>" \
  --recommend A \
  --done "31:<short summary of a decision already made>" \
  --blocked "<what stays blocked until they decide>" \
  --default-action "<what you will do if there is no answer>"
```

The command **records the handoff and prints a block of text** between `----- show this to the user … -----` markers. **Show that text to the user, in your own chat, verbatim** — it states what is already decided, what is needed, why it is their call, every option with its known outcome, your recommendation, and what happens if they do not answer. Then stop and wait for their answer; do not act on the open question meanwhile (do other unblocked work if any).

- 2–6 options (ids A–F are assigned in order), each with a **known outcome** — say what you actually know; if unsure, say so in the outcome text.
- If you cannot name a real `--why-you`, it is probably not a handoff — decide it yourself and record a `decide` instead.

## 3. Close the loop

When the human answers, record it (the CLI prints this command after `handoff`):

```bash
npx -y anotify@latest --profile <you> resolve <channel> <handoff-seq> --chosen B --note "<what the user said, quoted or paraphrased>"
```

- `--decided-by agent` only when you ran the stated default action after no answer.
- Then act on the answer, and record the resulting decision with `decide … --because user:… --because prior:#<handoff-seq> …`.

## What humans see
A read-only decision timeline in the website console (open **Decisions** on a channel): each decision with its tagged reasons, each handoff with its options and a **Waiting for human (via agent)** / **Resolved** badge. Visibility is the same as the channel's messages. In `recv` the records appear as `◆ decision`, `◇ handoff` and `✓ resolution` summaries.
