# Repository conventions for agents and contributors

## Every commit message carries a decision trace

A diff shows *what* changed; the commit message must say **what was decided and why** — so a reviewer (or a later agent) can audit the decision without replaying the session. This is the same idea as Anotify's decision trace feature, applied to the repo itself.

Required in every commit that changes files (including merges you author and fixups):

```
<type>(<scope>): <subject>            # conventional-commit style, as in the existing history

Decision: <what was decided / done — one or two sentences, active voice>
Why:
- user: <what the user asked or said that led to this; quote or paraphrase>
- rule: <the repo rule, doc section, convention or spec that requires it (e.g. DESIGN.md §4.2)>
- fact: <something verified: command + result, version, measured behaviour, doc URL>
- prior: <earlier commit sha / decision this builds on or reverses>
Rejected: <alternatives considered and why not>        # optional, include when a real choice was made
Unverified: <what was NOT tested or checked>           # include whenever something is untested

<attribution trailers, if the tooling adds them>
```

Rules:

1. **`Decision:` and at least one `Why:` line are mandatory.** Every `Why:` line starts with one of the tags `user`, `rule`, `fact`, `prior` — the reason has to be one of: the user asked for it, a rule requires it, an objective fact forces it, or an earlier decision implies it. "Seemed cleaner" is not a reason; if that is all there is, say so under `Why:` as `- judgment: …` rather than dressing it up.
2. **Facts must be checkable.** Name the command, version or URL. Do not write a fact you did not observe; put it under `Unverified:` instead.
3. **Be honest about gaps.** Untested paths, assumed behaviour and skipped checks go under `Unverified:`. A commit that says "tested ✓" for something that was only reasoned about is a bug in the trace.
4. **One decision per commit when possible.** If a commit bundles several decisions, give each its own `Decision:` / `Why:` pair.
5. **Say who decided.** `user:` means the human requested or approved it. If an agent chose on its own, use `judgment:` (or `rule:` / `fact:`) — never attribute an agent's choice to the user.

Example:

```
fix(cli): daemon install crash on all platforms

Decision: make installDaemon use the {raw, quoted} object returned by buildStartArgs instead of mapping it as an array.
Why:
- fact: `anotify daemon install` threw before reaching any platform branch (macOS run: no plist written, clean failure).
- prior: 1.2.11 changed buildStartArgs to return {raw, quoted} but left the call site on .map(String).
Unverified: Windows Task Scheduler path not re-run after this change.
```
