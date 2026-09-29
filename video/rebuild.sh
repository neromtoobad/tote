#!/bin/sh
# Re-render every media deliverable from the current UI.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
if [ "$1" != "--replay-only" ]; then
  node render.mjs final4 --stills 58,121
  node deck.mjs pdf
  # `wait` alone always succeeds; wait on each job so a failed scene stops the build.
  node deck.mjs scene intro & a=$!
  node deck.mjs scene tech & b=$!
  node deck.mjs scene outro & c=$!
  wait $a && wait $b && wait $c
fi
# The demo shift (DESK=1 BREAK=1 WRONG=1 TAPE=desk1 node scripts/drive.ts), cut to
# ready + first pick, short + rush, misread, spill, Tote Desk, and the report.
node mix.mjs desk1
node render.mjs desk1 --workers 6
node assemble.mjs desk1 --demo-from 5.0 --demo-to 255.8 --cut 24.2-34.2 --cut 53.1-82.3 --cut 99.2-164.2 \
  --cut 174.9-181.3 --cut 213.0-247.5 --over 5:6@0.5 --zoom 5:3.4-5.0:960,800,1.75
ffmpeg -loglevel error -y -i out/tote-demo.mp4 -c:v copy -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a aac -b:a 192k -ar 48000 -movflags +faststart out/tote-demo-norm.mp4
mv out/tote-demo-norm.mp4 out/tote-demo.mp4
echo REBUILD_DONE
