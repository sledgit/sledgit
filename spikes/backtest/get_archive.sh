#!/bin/sh
# Download Binance's official NEARUSDT 5m spot klines and futures funding archive, verifying SHA-256 checksums.
set -eu
cd "$(dirname "$0")/data"
B=https://data.binance.vision/data
fetch() { # url
  f=$(basename "$1")
  [ -f "$f" ] || curl -sf --max-time 60 -O "$1" || { echo "missing $f"; return 0; }
  want=$(curl -sf --max-time 30 "$1.CHECKSUM" | cut -d' ' -f1)
  have=$(shasum -a 256 "$f" | cut -d' ' -f1)
  [ "$want" = "$have" ] || { echo "CHECKSUM MISMATCH $f"; rm -f "$f"; exit 1; }
}
y=2020; m=10
while :; do
  ym=$(printf "%04d-%02d" $y $m)
  [ "$ym" = "2026-10" ] && break
  fetch "$B/spot/monthly/klines/NEARUSDT/5m/NEARUSDT-5m-$ym.zip"
  fetch "$B/futures/um/monthly/fundingRate/NEARUSDT/NEARUSDT-fundingRate-$ym.zip"
  m=$((m+1)); [ $m -gt 12 ] && { m=1; y=$((y+1)); }
done
for d in $(seq -w 1 27); do fetch "$B/spot/daily/klines/NEARUSDT/5m/NEARUSDT-5m-2026-10-$d.zip"; done
echo "files: $(ls *.zip | wc -l)"
