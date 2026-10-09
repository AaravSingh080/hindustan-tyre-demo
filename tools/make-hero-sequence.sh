#!/usr/bin/env bash
# Turn the hero clip into the two frame sequences the hero scrubs on scroll, and cut the matching posters.
#   tools/make-hero-sequence.sh clip.mp4 [subject-centre-x, 0..1, default 0.66] [frames per second to keep, default 12] [webp quality, default 62]
# Writes:
#   assets/seq/hero/f_0001.webp ...        1600x900, the full 16:9 frame, for desktop and landscape screens
#   assets/seq/hero-tall/f_0001.webp ...   720x1080, cut around the subject, for phones held upright
#   assets/img/scenes/hero-film.webp / hero-film-tall.webp   frame 0 of each, shown before the frames arrive
# Keep a whole divisor of the clip's own rate (12 of 24, 15 of 30) so every kept frame is the same distance
# apart; an uneven pick shows as judder when the page is scrolled slowly.
# Then set the two frame counts printed below on SCENE_CONFIG.hero in js/main.js.
# Re-exporting a shorter clip into an existing folder leaves the old tail frames behind:
# delete the folders yourself first in that case.
set -euo pipefail
clip="$1"; cx="${2:-0.66}"; fps="${3:-12}"; q="${4:-62}"
mkdir -p assets/seq/hero assets/seq/hero-tall assets/img/scenes
full="scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080"
ffmpeg -v error -y -i "$clip" -vf "fps=${fps},${full},scale=1600:900:flags=lanczos" -c:v libwebp -quality "$q" assets/seq/hero/f_%04d.webp
ffmpeg -v error -y -i "$clip" -vf "fps=${fps},${full},crop=720:1080:(iw*${cx}-360):0" -c:v libwebp -quality "$q" assets/seq/hero-tall/f_%04d.webp
ffmpeg -v error -y -i "$clip" -vf "${full}" -frames:v 1 -c:v libwebp -quality 84 assets/img/scenes/hero-film.webp
ffmpeg -v error -y -i "$clip" -vf "${full},crop=720:1080:(iw*${cx}-360):0" -frames:v 1 -c:v libwebp -quality 84 assets/img/scenes/hero-film-tall.webp
for d in hero hero-tall; do echo "assets/seq/$d  frames: $(ls assets/seq/$d | wc -l)  size: $(du -sh assets/seq/$d | cut -f1)"; done
