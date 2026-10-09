#!/usr/bin/env bash
# Turn a clip into a scroll-scrub frame sequence.
#   tools/make-sequence.sh clip.mp4 tyre 960 12 72            -> assets/seq/tyre/f_0001.webp ...
#   tools/make-sequence.sh clip.mp4 tyre 960 12 72 0.64 0.5    -> same, but first cut to a square around (cx, cy)
# args: clip, scene name, width (px), frames per second to keep, webp quality,
#       and optionally the centre of a square crop as fractions of the frame (for a 16:9 clip whose scene is square)
# Then set frames: { dir: 'assets/seq/<name>', count: <printed count>, ext: 'webp' }
# on that scene in js/main.js (SCENE_CONFIG).
# Re-exporting a shorter clip into an existing folder leaves the old tail frames behind:
# delete the folder yourself first in that case.
set -euo pipefail
clip="$1"; name="$2"; width="${3:-1280}"; fps="${4:-12}"; q="${5:-70}"; cx="${6:-}"; cy="${7:-0.5}"
out="assets/seq/$name"
mkdir -p "$out"
crop=""
if [ -n "$cx" ]; then
  # a square the height of the frame, centred on (cx, cy) and kept inside the picture
  crop="crop=ih:ih:min(max(iw*${cx}-ih/2\,0)\,iw-ih):0,"
fi
ffmpeg -v error -y -i "$clip" -vf "fps=${fps},${crop}scale=${width}:-2:flags=lanczos" -c:v libwebp -quality "$q" "$out/f_%04d.webp"
echo "frames: $(ls "$out" | wc -l)  size: $(du -sh "$out" | cut -f1)  ->  $out"
