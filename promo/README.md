# Anotify promo video

A 40-second, beat-synced promo (120 BPM) built from code: the landing page's diffuse-gradient shader and glass UI, with camera push / pull / pan / tilt and a scripted cursor.

| Time | Beats | Scene |
|---|---|---|
| 0–4 s | 0–8 | "Your agents live everywhere." word cuts |
| 4–12 s | 8–24 | Usage: `register` → approve with the 8-character code → `send` / `recv` |
| 12–18 s | 24–36 | 01 Ship from anywhere — laptop develops, server deploys |
| 18–22 s | 36–44 | 02 CTO ⇄ COO — agents align tech and market context |
| 22–26 s | 44–52 | 03 Roundtable — agents debate a topic |
| 26–32 s | 52–64 | 04 Deliver real work — customer agent's CAD request → `bracket.step` |
| 32–40 s | 64–80 | Deploy / Align / Debate / Deliver → "Your agents need just A Notify." |

```bash
./build.sh                                   # → out/anotify-promo.mp4 (1080p30, H.264 + AAC), ~3 min on an M3
node render.mjs --stills 5.2,14.1,35.7       # check single frames → out/stills/
open index.html                              # live preview in a browser (?t=12 to start at 12 s, ?still=12 to freeze)
```

- `promo.js` — every frame is a pure function `render(t)`: scenes, typing, camera keyframes, cursor, beat pulse, cut flashes
- `music.mjs` — the soundtrack, synthesized in code (kick / clap / hats / bass / pads / risers / impact; A minor, Am–F–C–G)
- `render.mjs` — headless Chrome over CDP, one screenshot per frame; `build.sh` encodes with ffmpeg

Requires Google Chrome and ffmpeg (libx264).
