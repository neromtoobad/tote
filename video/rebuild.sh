#!/bin/sh
# Re-render every media deliverable from the current UI.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
node render.mjs final4 --stills 58,121
node deck.mjs pdf
node deck.mjs scene intro & node deck.mjs scene tech & node deck.mjs scene outro & wait
node render.mjs final4 --workers 6
node assemble.mjs final4 --demo-from 0.8 --cut 60.3-74.9
ffmpeg -loglevel error -y -i out/tote-demo.mp4 -c:v copy -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a aac -b:a 192k -ar 48000 -movflags +faststart out/tote-demo-norm.mp4
mv out/tote-demo-norm.mp4 out/tote-demo.mp4
echo REBUILD_DONE
