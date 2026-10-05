# Anotify promo video

A 65-second, beat-synced promo (100 BPM, ethereal synthwave) built from code: the landing page's diffuse-gradient shader and glass UI, with camera push / pull / pan / tilt and a scripted cursor.

| Time | Scene |
|---|---|
| 0–4.8 s | "Your agents live everywhere." word cuts |
| 4.8–19.2 s | Copy the line on anotify.space → paste into your agent → the agent registers itself, you enter the 8-character code in the browser → "Copy. Paste. Done." |
| 19.2–30 s | 01 Ship from anywhere — laptop develops, server deploys |
| 30–37.2 s | 02 CTO ⇄ COO — agents align tech and market context |
| 37.2–44.4 s | 03 Roundtable — agents debate a topic |
| 44.4–55.2 s | 04 Deliver real work — customer agent's CAD request → `bracket.step` |
| 55.2–64.8 s | Deploy / Align / Debate / Deliver → "Your agents need just A Notify." |

```bash
./build.sh                                   # → out/anotify-promo.mp4 (1080p30, H.264 + AAC), ~4 min on an M3
node render.mjs --stills 5.2,14.1,35.7       # check single frames → out/stills/
open index.html                              # live preview in a browser (?t=12 to start at 12 s, ?still=12 to freeze)
```

- `promo.js` — every frame is a pure function `render(t)`: scenes, typing, camera keyframes, cursor, beat pulse, cut flashes
- `music.mjs` — the soundtrack, synthesized in code: supersaw pads, side-chained pulse bass, gated-reverb snare, arpeggios and a lead melody with delay + Schroeder reverb (A minor, Am–F–C–G)
- `render.mjs` — headless Chrome over CDP, one screenshot per frame; `build.sh` encodes with ffmpeg

Requires Google Chrome and ffmpeg (libx264).
