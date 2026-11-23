# ClipBest - plan ($0 budget)

## What works today (MVP, in this folder)
Paste a YouTube link -> finds the hottest moments -> 5 vertical 9:16 clips (1080x1920, blurred background) -> preview + download.
- Moment detection #1: YouTube "Most replayed" heatmap (best signal, free, no AI needed)
- Moment detection #2 (fallback): loudness/energy peaks from the audio (crowd roar, streamer screaming)
- Run: `node server.js` then open http://localhost:3000

## AI hooks setup
- Default for everyone: set `GEMINI_API_KEY` (free key from https://aistudio.google.com/apikey). No key = basic free hooks.
- Optional server keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (paid). Priority: Gemini > Claude > OpenAI > free.
- Model overrides: `GEMINI_MODEL` (default gemini-3.5-flash-lite), `CLAUDE_MODEL` (claude-opus-5-5), `OPENAI_MODEL` (gpt-6-luna).
- Visitors can pick Gemini / Claude / OpenAI and paste their own key under "Customize hooks". Their key is used for that one job only, never returned by the API or logged. "Remember key" stores it in their own browser only.
- Tone presets (Hype, Funny, Mystery, Story, Informative) + custom instructions (max 1000 chars) go to whichever AI is active.
- If a provider fails (bad key, quota, outage), clips still render with basic hooks and the UI shows why.

## Roadmap (all free tiers)
1. Auto captions: faster-whisper (local) or Gemini free API -> burn big word-by-word subtitles (what makes clips go viral).
2. AI virality score + title/hashtags: Gemini free tier reads transcript, scores each moment, writes hook text.
3. Face/subject tracking crop (instead of blur background) for facecam streams: OpenCV/MediaPipe.
4. Live streams: record last N minutes of an ongoing stream with yt-dlp `--live-from-start` / twitch VOD, then same pipeline.
5. Accounts + queue: Supabase free tier (auth + DB), clips auto-delete after 24h to save disk.
6. Auto-post: TikTok/YouTube Shorts APIs (needs app approval, do later).

## Hosting for $0
- Frontend: Cloudflare Pages / Vercel free.
- Worker (the heavy part): your own PC + Cloudflare Tunnel (free) to expose it -> $0.
  Later: Oracle Cloud Always Free ARM VM (4 cores, 24 GB) runs the same code 24/7.
- Storage: Cloudflare R2 free 10 GB. Delete clips after 24h.

## Revenue
- Free: 3 clips/day with small watermark. Pro ($9/mo): no watermark, 20 clips, captions, 1080p.
- Ads on the result page (AdSense) once traffic exists.
- Affiliate links (editors, CapCut, hosting) on the results page.
- Use your own tool to run clipping pages (GTA 6 content) and earn from Whop/Content Rewards campaigns - this is the fastest money while the site grows.

## Risks (be honest early)
- Downloading from YouTube breaks YouTube's ToS and yt-dlp breaks when they change things (update it often). Expect IP blocks if you serve many users from one IP -> keep it to creators clipping own/permitted content, or build "paste a link you have rights to".
- Rockstar/GTA 6 footage and streamer content is copyrighted. Clipping others' content for ad/subscription revenue = takedowns/strikes. Safest: partner with creators who WANT clips (they give permission), or tool-only (users supply rights).
- Heavy video compute is the real cost at scale: that is why Pro tier exists.
