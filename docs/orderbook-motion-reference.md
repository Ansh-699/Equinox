# Order book motion reference

Source: `/home/anshtyagi/Videos/Screencasts/Screencast From 2026-09-24 21-50-01.mp4` (388 × 676, 17.56 s, approximately 28.8 fps).

The recording shows a fixed three-column ladder. Around 10–13 seconds, the quoted prices step through several levels. A native-frame stack from 10.0–11.05 seconds shows the center price and arrow switching direction on a quote update, while the red ask and green bid depth boundaries move over adjacent frames. The bars retain their stepped profile. No row scale or large background flash is visible in these frames.

Implementation timing follows the requested bounds: numeric color returns to its normal value in 180 ms, the center price in 200 ms, and changed depth bars settle in 160 ms with `cubic-bezier(0.16, 1, 0.3, 1)`. Data text updates immediately; the animation only marks the change. The center arrow clears after 200 ms as requested, while the reference arrow remains visible in several sampled frames.

To reproduce the inspection:

```bash
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate -of default=noprint_wrappers=1 '/home/anshtyagi/Videos/Screencasts/Screencast From 2026-09-24 21-50-01.mp4'
ffmpeg -hide_banner -loglevel error -ss 9.5 -t 4 -i '/home/anshtyagi/Videos/Screencasts/Screencast From 2026-09-24 21-50-01.mp4' -vf 'fps=8,crop=388:460:0:45,tile=4x8' -frames:v 1 /tmp/stockstream-orderbook-transition.png
ffmpeg -hide_banner -loglevel error -ss 10 -t 1.05 -i '/home/anshtyagi/Videos/Screencasts/Screencast From 2026-09-24 21-50-01.mp4' -vf 'crop=388:320:0:190,tile=6x5' -frames:v 1 /tmp/stockstream-orderbook-native-frames.png
```
