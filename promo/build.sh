#!/bin/bash
# 一键生成宣传片：逐帧渲染 → 合成配乐 → ffmpeg 编码（H.264 + AAC，1080p30）
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out/frames
node render.mjs --fps 30
node music.mjs
ffmpeg -hide_banner -loglevel error -y \
  -framerate 30 -i out/frames/%05d.jpg -i out/music.wav \
  -vf "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p" \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:v libx264 -preset slow -crf 18 -movflags +faststart \
  -c:a aac -b:a 192k -shortest out/anotify-promo.mp4
echo "✓ $(pwd)/out/anotify-promo.mp4"
