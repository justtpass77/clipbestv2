// ClipBest - Long videos in, viral vertical clips out.
// $0 budget: yt-dlp + ffmpeg + local GPU + Gemini free AI.
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const archiver = require('archiver');
const multer = require('multer');
const { generateHooks, transcribeAudioClip, detectFacecamFromImage, serverProvider, MODELS, LABELS, STYLES } = require('./ai');
const { buildAss, CAPTION_STYLES } = require('./captions');

const YTDLP_BIN = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP = fs.existsSync(path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', YTDLP_BIN))
  ? path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', YTDLP_BIN)
  : (process.env.YTDLP_PATH || 'yt-dlp');
const WORK = path.join(__dirname, 'work');
const CLIP_LEN = 35;      // seconds per clip
const MAX_CLIPS = 10;     // moments we look for
const FREE_CLIPS = 3;     // rendered on the free plan; the rest are shown locked
const RETENTION_MS = (Number(process.env.CLIPBEST_RETENTION_HOURS) || 24) * 60 * 60 * 1000;
const LICENSES_FILE = path.join(__dirname, 'licenses.json');
const PAYMENT_CONFIG_FILE = path.join(__dirname, 'payment-config.json');

function loadPaymentConfig() {
  let cfg = {
    gumroad: {
      proUrl: process.env.GUMROAD_CREATOR_PRO_URL || 'https://gumroad.com/l/clipbest-pro',
      agencyUrl: process.env.GUMROAD_AGENCY_URL || 'https://gumroad.com/l/clipbest-agency',
      proPermalink: process.env.GUMROAD_PRO_PERMALINK || 'clipbest-pro',
      agencyPermalink: process.env.GUMROAD_AGENCY_PERMALINK || 'clipbest-agency',
    },
    mode: process.env.PAYMENT_MODE || 'live'
  };
  try {
    if (fs.existsSync(PAYMENT_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PAYMENT_CONFIG_FILE, 'utf8'));
      if (saved.gumroad) {
        cfg.gumroad.proUrl = saved.gumroad.proUrl || cfg.gumroad.proUrl;
        cfg.gumroad.agencyUrl = saved.gumroad.agencyUrl || cfg.gumroad.agencyUrl;
        cfg.gumroad.proPermalink = saved.gumroad.proPermalink || cfg.gumroad.proPermalink;
        cfg.gumroad.agencyPermalink = saved.gumroad.agencyPermalink || cfg.gumroad.agencyPermalink;
      }
      if (saved.mode) cfg.mode = saved.mode;
    }
  } catch {}
  return cfg;
}

function savePaymentConfig(cfg) {
  try {
    fs.writeFileSync(PAYMENT_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    console.error('[payment] Failed to save payment config:', err.message);
  }
}

// Pro unlock codes (comma-separated env var or persistent licenses.json)
const PRO_CODES = new Set((process.env.CLIPBEST_PRO_CODES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const jobs = {};

function loadLicenses() {
  try {
    if (fs.existsSync(LICENSES_FILE)) return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveLicenses(data) {
  try {
    fs.writeFileSync(LICENSES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[licenses] Failed to save licenses:', err.message);
  }
}

function isProCode(code) {
  if (!code) return false;
  const c = String(code).trim().toLowerCase();
  if (PRO_CODES.has(c)) return true;
  const lics = loadLicenses();
  return !!lics[c] || !!lics[String(code).trim()];
}

// Automated work directory cleanup (removes jobs older than 24h)
function cleanupWorkDir() {
  try {
    if (!fs.existsSync(WORK)) return;
    const now = Date.now();
    const entries = fs.readdirSync(WORK, { withFileTypes: true });
    let removed = 0;
    for (const ent of entries) {
      if (ent.isDirectory() && ent.name !== '_uploads') {
        const p = path.join(WORK, ent.name);
        try {
          const stat = fs.statSync(p);
          if (now - stat.mtimeMs > RETENTION_MS) {
            fs.rmSync(p, { recursive: true, force: true });
            delete jobs[ent.name];
            removed++;
          }
        } catch {}
      }
    }
    if (removed > 0) {
      console.log(`[cleanup] Pruned ${removed} expired job directory/directories older than ${RETENTION_MS / 3600000}h`);
    }
  } catch (err) {
    console.error('[cleanup] Failed to prune work directory:', err.message);
  }
}
cleanupWorkDir();
setInterval(cleanupWorkDir, 60 * 60 * 1000);

const YT_ARGS = ['--no-playlist'];

// ---- encoder: use the GPU if ffmpeg can, else fast CPU x264 ----
const CPU_ENCODER = { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '23'] };
const GPU_ENCODERS = [
  { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23'] },
  { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-global_quality', '23'] },
  { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'] },
  { name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-q:v', '60'] },
];
let ENCODER = CPU_ENCODER;
async function detectEncoder() {
  if (process.env.CLIPBEST_ENCODER === 'cpu') return;
  for (const e of GPU_ENCODERS) {
    try {
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=1080x1920:d=0.2', '-frames:v', '2', ...e.args, '-f', 'null', '-']);
      ENCODER = e; return;
    } catch { /* not available on this machine */ }
  }
}

// ---- output formats + framing ----
const FORMATS = {
  '9:16': [1080, 1920], // TikTok, Reels, Shorts
  '4:5': [1080, 1350],  // Instagram / Facebook feed
  '1:1': [1080, 1080],  // square feed
  '16:9': [1920, 1080], // YouTube, X
};

// fit   = whole frame visible, blurred copy fills empty space
// fill  = zoom into center so it fills edge to edge
// split = streamer facecam layout: isolates the streamer webcam on top and gameplay on bottom
// zoom  = punch-in edit: jumps to 118% for 3s out of every 6s
function videoFilter(W, H, framing, zoom, assFile, facecamPos = 'bottom-left') {
  const even = n => Math.round(n / 2) * 2;
  const bw = even(W / 4), bh = even(H / 4);
  const zoomChain = zoom
    ? `,fps=30,zoompan=z='if(gte(mod(it,6),3),1.18,1)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=30`
    : '';
  const tail = zoomChain + (assFile ? `,ass=${assFile}` : '') + ',format=yuv420p[v]';

  if (framing === 'split') {
    const topH = even(H * 0.38); // Streamer top section height (38%)
    const botH = H - topH;       // Gameplay bottom section height (62%)

    // Precisely isolate the webcam from its quadrant so the streamer is centered & full size
    let cropA = 'crop=iw*0.38:ih*0.48:0:ih*0.52'; // default: bottom-left
    if (facecamPos === 'top-left') {
      cropA = 'crop=iw*0.38:ih*0.48:0:0';
    } else if (facecamPos === 'top-right') {
      cropA = 'crop=iw*0.38:ih*0.48:iw*0.62:0';
    } else if (facecamPos === 'bottom-right') {
      cropA = 'crop=iw*0.38:ih*0.48:iw*0.62:ih*0.52';
    } else if (facecamPos === 'center') {
      cropA = 'crop=iw*0.45:ih*0.6:iw*0.275:ih*0.1';
    }

    return `[0:v]split[a][b];` +
      `[a]${cropA},scale=${W}:${topH}:force_original_aspect_ratio=increase,crop=${W}:${topH}[vtop];` +
      `[b]crop=iw*0.75:ih:iw*0.125:0,scale=${W}:${botH}:force_original_aspect_ratio=increase,crop=${W}:${botH}[vbot];` +
      `[vtop][vbot]vstack${tail}`;
  }

  if (framing === 'fill') {
    return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${tail}`;
  }

  // default: fit with blurred background
  return `[0:v]split[a][b];[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,scale=${W}:${H}[bg];` +
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${tail}`;
}

// Semaphore for hardware/software encode queues
function slots(n) {
  let active = 0; const waiting = [];
  const next = () => { if (active < n && waiting.length) { active++; waiting.shift()(); } };
  return {
    use: fn => new Promise((resolve, reject) => {
      waiting.push(() => fn().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    }),
  };
}
const renderSlots = slots(Number(process.env.CLIPBEST_RENDERS) || 2);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/clips', express.static(WORK));

// Multer upload staging
const uploadDir = path.join(WORK, '_uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error((err || out).slice(-400)))));
  });
}

// ---- moment detection ----
function peaksFromSeries(series, step, duration, n) {
  const win = Math.max(1, Math.round(CLIP_LEN / step));
  const scored = [];
  for (let i = 0; i < series.length; i++) {
    let s = 0;
    for (let j = i; j < Math.min(series.length, i + win); j++) s += series[j];
    scored.push({ i, score: s / win });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of scored) {
    const start = c.i * step;
    if (start + CLIP_LEN > duration + 1) continue;
    if (picked.every(p => Math.abs(p.start - start) >= CLIP_LEN + 15)) {
      picked.push({ start, score: c.score });
      if (picked.length >= n) break;
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

async function audioLoudness(url, id) {
  const a = path.join(WORK, id, 'audio.m4a');
  await run(YTDLP, [...YT_ARGS, '-f', 'ba', '-o', a, url]);
  return a;
}

async function loudnessSeries(id) {
  const dir = path.join(WORK, id);
  const filter = `aresample=8000,astats=metadata=1:reset=8000,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt`;
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', 'audio.m4a', '-vn', '-af', filter, '-f', 'null', '-'], { cwd: dir, windowsHide: true });
    p.on('close', c => (c === 0 ? resolve() : reject(new Error('ffmpeg audio analysis failed'))));
  });
  const lines = fs.readFileSync(path.join(dir, 'rms.txt'), 'utf8').split('\n');
  const vals = [];
  for (const l of lines) {
    const m = l.match(/RMS_level=(-?[\d.]+|-inf)/);
    if (m) vals.push(m[1] === '-inf' ? -90 : parseFloat(m[1]));
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const norm = vals.map(v => (v - min) / (max - min || 1));
  return norm.map((v, i) => v + Math.max(0, v - (norm[i - 3] ?? v)) * 0.5);
}

// ---- captions (YouTube auto-caption word timings -> karaoke-style ASS) ----
async function fetchWords(url, dir) {
  try {
    await run(YTDLP, [...YT_ARGS, '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en-orig,en,en-US,en-GB',
      '--sub-format', 'json3', '--no-playlist', '-o', path.join(dir, 'subs'), url]).catch(() => {});
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.json3'));
    const pref = ['subs.en-orig.json3', 'subs.en.json3', 'subs.en-US.json3', 'subs.en-GB.json3'];
    const f = pref.find(p => files.includes(p)) || files[0];
    if (!f) return [];
    const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const words = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const evStart = ev.tStartMs || 0, evDur = ev.dDurationMs || 2000;
      for (const s of ev.segs) {
        const t = (s.utf8 || '').replace(/\[[^\]]*\]|>>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const parts = t.split(' ');
        if (parts.length === 1) { words.push({ t, start: evStart + (s.tOffsetMs || 0) }); continue; }
        const per = evDur / parts.length;
        parts.forEach((p, i) => words.push({ t: p, start: evStart + (s.tOffsetMs || 0) + i * per }));
      }
    }
    words.sort((a, b) => a.start - b.start);
    for (let i = 0; i < words.length; i++) {
      const next = words[i + 1] ? words[i + 1].start : words[i].start + 500;
      words[i].end = Math.min(next, words[i].start + 700);
    }
    return words;
  } catch { return []; }
}

// Shared render loop for clip segments
async function renderClipSegments({ id, dir, job, spans, hooks, words, set }) {
  job.clips = [];
  let finished = 0;
  const total = spans.length;
  set(`Rendering ${total} clips`, 35, 4);

  const cutOne = async (k) => {
    const { start, end, n, score } = spans[k];
    const h = hooks[k];
    const raw = path.join(dir, `raw${k}.mp4`);
    const [W, H] = FORMATS[job.format];
    const ass = buildAss(
      job.captions ? words : [],
      start,
      end,
      h?.hook,
      job.capStyle,
      job.capColor,
      { W, H, fit: job.framing === 'fit' },
      !job.pro, // Watermark enabled on free plan
      job.pro && job.customBrand ? job.customBrand : null
    );
    if (ass) fs.writeFileSync(path.join(dir, `cap${k}.ass`), ass);

    const vf = videoFilter(W, H, job.framing, job.zoom, ass ? `cap${k}.ass` : null, job.resolvedFacecamPos || job.facecamPos);
    const encode = enc => run('ffmpeg', ['-y', '-i', `raw${k}.mp4`, '-filter_complex', vf, '-map', '[v]', '-map', '0:a?',
      ...enc, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', `clip${n}.mp4`], dir);

    await renderSlots.use(() => encode(ENCODER.args).catch(() => encode(CPU_ENCODER.args)));
    if (fs.existsSync(raw)) fs.unlinkSync(raw);

    job.clips.push({
      n, url: `/clips/${id}/clip${n}.mp4`, start, end,
      score: h ? h.virality : score,
      hook: h?.hook || '', caption: h?.caption || '', hashtags: h?.hashtags || [],
    });
    job.clips.sort((a, b) => a.n - b.n);
    finished++;
    set(`Rendering clips (${finished}/${total} ready)`, 35 + Math.round((finished / total) * 63), 4);
  };

  await Promise.all(spans.map(s => cutOne(s.k)));
}

// ---- pipeline: YouTube URL ----
async function processJob(id, url, secret = {}) {
  const job = jobs[id];
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir, { recursive: true });
  const set = (step, pct, stage) => { job.step = step; job.pct = pct; if (stage !== undefined) job.stage = stage; };
  try {
    set('Reading video info', 5, 0);
    const info = JSON.parse(await run(YTDLP, [...YT_ARGS, '-J', url]));
    job.title = info.title;
    job.thumb = info.thumbnail;
    const duration = info.duration;
    if (!duration) throw new Error('Live streams must have ended - paste the VOD link once the stream is over.');

    set('Finding the hottest moments', 15, 1);
    let moments, method;
    if (Array.isArray(info.heatmap) && info.heatmap.length > 5) {
      const h = info.heatmap;
      const step = h[0].end_time - h[0].start_time;
      moments = peaksFromSeries(h.map(x => x.value), step, duration, MAX_CLIPS);
      method = 'Most-replayed data';
    } else {
      await audioLoudness(url, id);
      moments = peaksFromSeries(await loudnessSeries(id), 1, duration, MAX_CLIPS);
      method = 'Crowd/voice energy';
    }
    job.method = method;
    if (!moments.length) throw new Error('Could not find a good moment in this video.');

    moments.sort((a, b) => b.score - a.score);
    const toScore = s => Math.min(99, Math.round(60 + s * 39));
    job.locked = (job.pro ? [] : moments.slice(FREE_CLIPS)).map((m, i) => {
      const start = Math.max(0, Math.floor(m.start));
      return { n: FREE_CLIPS + i + 1, start, end: Math.min(duration, start + CLIP_LEN), score: toScore(m.score) };
    });
    if (!job.pro) moments = moments.slice(0, FREE_CLIPS);
    job.renderCount = moments.length;

    const spans = moments.map((m, k) => {
      const start = Math.max(0, Math.floor(m.start));
      const end = Math.min(duration, start + CLIP_LEN);
      return { k, n: k + 1, start, end, text: '', score: Math.min(99, Math.round(60 + m.score * 39)) };
    });

    // Start downloading clip segments
    const downloads = spans.map(s => run(YTDLP, [
      ...YT_ARGS, '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
      '--download-sections', `*${s.start}-${s.end}`, '--force-keyframes-at-cuts',
      '--merge-output-format', 'mp4', '-o', path.join(dir, `raw${s.k}.mp4`), url,
    ]));
    downloads.forEach(p => p.catch(() => {}));

    set('Reading the transcript', 22, 2);
    let words = await fetchWords(url, dir);

    // Audio transcription fallback if YouTube has no captions
    if (words.length === 0 && job.captions && (secret.apiKey || process.env.GEMINI_API_KEY)) {
      set('Transcribing speech with Gemini AI', 24, 2);
      for (const s of spans) {
        try {
          await downloads[s.k];
          const raw = path.join(dir, `raw${s.k}.mp4`);
          const sliceAudio = path.join(dir, `slice${s.k}.mp3`);
          await run('ffmpeg', ['-y', '-i', raw, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', sliceAudio]);
          if (fs.existsSync(sliceAudio)) {
            const buf = fs.readFileSync(sliceAudio);
            const chunkWords = await transcribeAudioClip(buf, 'audio/mp3', secret.apiKey);
            fs.unlinkSync(sliceAudio);
            for (const w of chunkWords) {
              words.push({
                t: w.t,
                start: Math.round(s.start * 1000 + w.start),
                end: Math.round(s.start * 1000 + w.end),
              });
            }
          }
        } catch (err) {
          console.warn(`[audio-fallback] Clip ${s.k} failed:`, err.message);
        }
      }
    }

    job.captionsFound = words.length > 0;
    for (const s of spans) {
      s.text = words.filter(w => w.start >= s.start * 1000 && w.start < s.end * 1000).map(w => w.t).join(' ');
    }

    set(job.hooks ? 'Writing hooks and captions' : 'Preparing clips', 28, 3);
    let hooks = [];
    if (job.hooks) {
      const r = await generateHooks({
        title: info.title, moments: spans, style: job.style, instructions: job.instructions,
        provider: secret.provider, apiKey: secret.apiKey,
      });
      hooks = r.hooks;
      job.hookSource = r.provider;
      job.hookLabel = LABELS[r.provider];
      job.hookNote = r.note;
    } else job.hookSource = 'off';
    secret.apiKey = null;

    // Await all downloads before rendering
    await Promise.all(downloads);

    if (job.framing === 'split') {
      if (job.facecamPos && job.facecamPos !== 'auto') {
        job.resolvedFacecamPos = job.facecamPos;
      } else {
        set('Detecting streamer facecam position', 30, 3);
        try {
          const probeFrame = path.join(dir, 'facecam_probe.jpg');
          await run('ffmpeg', ['-y', '-ss', '3', '-i', path.join(dir, 'raw0.mp4'), '-vframes', '1', probeFrame]);
          if (fs.existsSync(probeFrame)) {
            const buf = fs.readFileSync(probeFrame);
            job.resolvedFacecamPos = await detectFacecamFromImage(buf, secret.apiKey);
            fs.unlinkSync(probeFrame);
          } else {
            job.resolvedFacecamPos = 'bottom-left';
          }
        } catch (e) {
          job.resolvedFacecamPos = 'bottom-left';
        }
      }
    }

    await renderClipSegments({ id, dir, job, spans, hooks, words, set });

    set('Done', 100, 5);
    job.done = true;
  } catch (e) {
    job.error = String(e.message || e);
  }
}

// ---- pipeline: Local Video Upload ----
async function processLocalJob(id, sourcePath, originalName, secret = {}) {
  const job = jobs[id];
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir, { recursive: true });
  const localVideo = path.join(dir, 'source.mp4');
  fs.renameSync(sourcePath, localVideo);

  const set = (step, pct, stage) => { job.step = step; job.pct = pct; if (stage !== undefined) job.stage = stage; };
  try {
    set('Analyzing uploaded video', 5, 0);
    const probeOut = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', localVideo]);
    const duration = parseFloat(probeOut.trim());
    if (!duration || isNaN(duration)) throw new Error('Could not read video duration.');

    job.title = (originalName || 'Uploaded video').replace(/\.[^.]+$/, '');
    job.thumb = '';

    set('Finding the hottest moments', 15, 1);
    const audioPath = path.join(dir, 'audio.m4a');
    await run('ffmpeg', ['-y', '-i', localVideo, '-vn', '-c:a', 'aac', audioPath]);
    const moments = peaksFromSeries(await loudnessSeries(id), 1, duration, MAX_CLIPS);
    job.method = 'Audio energy analysis';
    if (!moments.length) throw new Error('Could not find enough highlights in this video.');

    moments.sort((a, b) => b.score - a.score);
    const toScore = s => Math.min(99, Math.round(60 + s * 39));
    job.locked = (job.pro ? [] : moments.slice(FREE_CLIPS)).map((m, i) => {
      const start = Math.max(0, Math.floor(m.start));
      return { n: FREE_CLIPS + i + 1, start, end: Math.min(duration, start + CLIP_LEN), score: toScore(m.score) };
    });
    if (!job.pro) moments.splice(FREE_CLIPS);
    job.renderCount = moments.length;

    const spans = moments.map((m, k) => {
      const start = Math.max(0, Math.floor(m.start));
      const end = Math.min(duration, start + CLIP_LEN);
      return { k, n: k + 1, start, end, text: '', score: Math.min(99, Math.round(60 + m.score * 39)) };
    });

    set('Extracting clips', 20, 2);
    for (const s of spans) {
      await run('ffmpeg', ['-y', '-ss', String(s.start), '-to', String(s.end), '-i', localVideo, '-c:v', 'copy', '-c:a', 'copy', path.join(dir, `raw${s.k}.mp4`)]);
    }

    // Audio transcription via AI
    const words = [];
    if (job.captions && (secret.apiKey || process.env.GEMINI_API_KEY)) {
      set('Transcribing speech with Gemini AI', 24, 2);
      for (const s of spans) {
        try {
          const raw = path.join(dir, `raw${s.k}.mp4`);
          const sliceAudio = path.join(dir, `slice${s.k}.mp3`);
          await run('ffmpeg', ['-y', '-i', raw, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', sliceAudio]);
          if (fs.existsSync(sliceAudio)) {
            const buf = fs.readFileSync(sliceAudio);
            const chunkWords = await transcribeAudioClip(buf, 'audio/mp3', secret.apiKey);
            fs.unlinkSync(sliceAudio);
            for (const w of chunkWords) {
              words.push({
                t: w.t,
                start: Math.round(s.start * 1000 + w.start),
                end: Math.round(s.start * 1000 + w.end),
              });
            }
          }
        } catch (e) {
          console.warn(`[audio-transcribe] Clip ${s.k} failed:`, e.message);
        }
      }
    }
    job.captionsFound = words.length > 0;
    for (const s of spans) {
      s.text = words.filter(w => w.start >= s.start * 1000 && w.start < s.end * 1000).map(w => w.t).join(' ');
    }

    set(job.hooks ? 'Writing hooks and captions' : 'Preparing clips', 28, 3);
    let hooks = [];
    if (job.hooks) {
      const r = await generateHooks({
        title: job.title, moments: spans, style: job.style, instructions: job.instructions,
        provider: secret.provider, apiKey: secret.apiKey,
      });
      hooks = r.hooks;
      job.hookSource = r.provider;
      job.hookLabel = LABELS[r.provider];
      job.hookNote = r.note;
    } else job.hookSource = 'off';
    secret.apiKey = null;

    if (job.framing === 'split') {
      if (job.facecamPos && job.facecamPos !== 'auto') {
        job.resolvedFacecamPos = job.facecamPos;
      } else {
        set('Detecting streamer facecam position', 30, 3);
        try {
          const probeFrame = path.join(dir, 'facecam_probe.jpg');
          await run('ffmpeg', ['-y', '-ss', '3', '-i', path.join(dir, 'raw0.mp4'), '-vframes', '1', probeFrame]);
          if (fs.existsSync(probeFrame)) {
            const buf = fs.readFileSync(probeFrame);
            job.resolvedFacecamPos = await detectFacecamFromImage(buf, secret.apiKey);
            fs.unlinkSync(probeFrame);
          } else {
            job.resolvedFacecamPos = 'bottom-left';
          }
        } catch (e) {
          job.resolvedFacecamPos = 'bottom-left';
        }
      }
    }

    await renderClipSegments({ id, dir, job, spans, hooks, words, set });

    if (fs.existsSync(localVideo)) fs.unlinkSync(localVideo);
    if (fs.existsSync(path.join(dir, 'audio.m4a'))) fs.unlinkSync(path.join(dir, 'audio.m4a'));

    set('Done', 100, 5);
    job.done = true;
  } catch (e) {
    job.error = String(e.message || e);
  }
}

// ---- API Routes ----

// Start YouTube clipping job
app.post('/api/jobs', (req, res) => {
  const url = (req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Paste a valid link' });
  const id = crypto.randomBytes(5).toString('hex');
  const pro = isProCode(req.body.proCode || req.body.code);
  jobs[id] = {
    id, step: 'Starting', pct: 0, stage: 0, done: false, clips: [], locked: [],
    captions: req.body.captions !== false, hooks: req.body.hooks !== false,
    style: STYLES[req.body.style] ? req.body.style : 'hype',
    instructions: String(req.body.instructions || '').slice(0, 1000),
    capStyle: CAPTION_STYLES[req.body.capStyle] ? req.body.capStyle : 'classic',
    capColor: /^#[0-9a-f]{6}$/i.test(req.body.capColor || '') ? req.body.capColor : null,
    format: FORMATS[req.body.format] ? req.body.format : '9:16',
    framing: ['fit', 'fill', 'split'].includes(req.body.framing) ? req.body.framing : 'fit',
    facecamPos: ['auto', 'bottom-left', 'bottom-right', 'top-left', 'top-right', 'center'].includes(req.body.facecamPos) ? req.body.facecamPos : 'auto',
    zoom: req.body.zoom === true,
    customBrand: req.body.customBrand ? String(req.body.customBrand).trim().slice(0, 40) : null,
    pro,
  };
  const provider = ['gemini', 'claude', 'openai'].includes(req.body.provider) ? req.body.provider : null;
  const apiKey = provider ? String(req.body.apiKey || '').trim().slice(0, 300) || null : null;
  processJob(id, url, { provider, apiKey });
  res.json({ id, pro });
});

// Upload local video file
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  const id = crypto.randomBytes(5).toString('hex');
  const pro = isProCode(req.body.proCode || req.body.code);
  jobs[id] = {
    id, step: 'Starting', pct: 0, stage: 0, done: false, clips: [], locked: [],
    captions: req.body.captions !== 'false' && req.body.captions !== false,
    hooks: req.body.hooks !== 'false' && req.body.hooks !== false,
    style: STYLES[req.body.style] ? req.body.style : 'hype',
    instructions: String(req.body.instructions || '').slice(0, 1000),
    capStyle: CAPTION_STYLES[req.body.capStyle] ? req.body.capStyle : 'classic',
    capColor: /^#[0-9a-f]{6}$/i.test(req.body.capColor || '') ? req.body.capColor : null,
    format: FORMATS[req.body.format] ? req.body.format : '9:16',
    framing: ['fit', 'fill', 'split'].includes(req.body.framing) ? req.body.framing : 'fit',
    facecamPos: ['auto', 'bottom-left', 'bottom-right', 'top-left', 'top-right', 'center'].includes(req.body.facecamPos) ? req.body.facecamPos : 'auto',
    zoom: req.body.zoom === 'true' || req.body.zoom === true,
    customBrand: req.body.customBrand ? String(req.body.customBrand).trim().slice(0, 40) : null,
    pro,
  };
  const provider = ['gemini', 'claude', 'openai'].includes(req.body.provider) ? req.body.provider : null;
  const apiKey = provider ? String(req.body.apiKey || '').trim().slice(0, 300) || null : null;
  processLocalJob(id, req.file.path, req.file.originalname, { provider, apiKey });
  res.json({ id, pro });
});

// Job status polling
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// Download All clips as a ZIP archive
app.get('/api/jobs/:id/zip', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Job not found' });
  if (!j.clips || !j.clips.length) return res.status(400).json({ error: 'No clips ready yet' });

  const dir = path.join(WORK, req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Job directory not found' });

  const safeTitle = (j.title || 'clipbest').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  res.attachment(`${safeTitle}_clips.zip`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).send({ error: err.message });
  });
  archive.pipe(res);

  // Add every ready clip
  for (const c of j.clips) {
    const clipPath = path.join(dir, `clip${c.n}.mp4`);
    if (fs.existsSync(clipPath)) {
      archive.file(clipPath, { name: `clip-${c.n}.mp4` });
    }
  }

  // Include ready-to-paste captions, hooks, and hashtags
  let summary = `Clipbest - Generated Clips\nVideo: ${j.title || 'Untitled'}\n\n`;
  for (const c of j.clips) {
    summary += `========================================\nCLIP ${c.n} (Virality Score: ${c.score}/100)\n`;
    summary += `Hook Title: ${c.hook || 'N/A'}\n`;
    summary += `Caption:    ${c.caption || 'N/A'}\n`;
    summary += `Hashtags:   ${(c.hashtags || []).join(' ')}\n\n`;
  }
  archive.append(summary, { name: 'captions-and-hooks.txt' });
  archive.finalize();
});

// Export metadata as CSV for social media scheduling tools (Buffer, Metricool, TikTok)
app.get('/api/jobs/:id/csv', (req, res) => {
  const j = jobs[req.params.id];
  if (!j || !j.done) return res.status(404).send('Job not found or still processing');

  let csv = 'Clip Number,Filename,Virality Score,Start Time,End Time,Duration Sec,Hook Title,Caption,Hashtags\n';
  for (const c of (j.clips || [])) {
    const fn = `clip-${c.n}.mp4`;
    const dur = Math.round(c.end - c.start);
    const hook = `"${(c.hook || '').replace(/"/g, '""')}"`;
    const cap = `"${(c.caption || '').replace(/"/g, '""')}"`;
    const tags = `"${(c.hashtags || []).join(' ').replace(/"/g, '""')}"`;
    const startFmt = `${Math.floor(c.start / 60)}:${String(Math.floor(c.start % 60)).padStart(2, '0')}`;
    const endFmt = `${Math.floor(c.end / 60)}:${String(Math.floor(c.end % 60)).padStart(2, '0')}`;
    csv += `${c.n},${fn},${c.score},${startFmt},${endFmt},${dur},${hook},${cap},${tags}\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="clipbest-${req.params.id}-manifest.csv"`);
  res.send(csv);
});

function getLicenseInfo(code) {
  if (!code) return { valid: false, plan: 'none' };
  const c = String(code).trim().toLowerCase();
  if (PRO_CODES.has(c)) {
    return { valid: true, plan: 'pro', code: String(code).trim(), email: 'founding-member@clipbest.local' };
  }
  const lics = loadLicenses();
  const entry = lics[c] || lics[String(code).trim()];
  if (entry) {
    return { valid: true, plan: entry.plan || 'pro', code: entry.code || String(code).trim(), email: entry.email || '' };
  }
  return { valid: false, plan: 'none' };
}

// Verify Pro code (checks local licenses, PRO_CODES, and Gumroad API)
app.post('/api/verify-code', async (req, res) => {
  const code = (req.body.code || '').trim();
  const info = getLicenseInfo(code);
  if (info.valid) {
    return res.json(info);
  }

  // If not found locally, verify directly with Gumroad's official license API
  const cfg = loadPaymentConfig();
  const permalinks = [cfg.gumroad.proPermalink, cfg.gumroad.agencyPermalink].filter(Boolean);

  for (const permalink of permalinks) {
    try {
      const response = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          product_permalink: permalink,
          license_key: code,
          increment_uses_count: 'false'
        })
      });
      const data = await response.json();
      if (data.success && !data.purchase?.refunded && !data.purchase?.chargebacked) {
        const plan = permalink.includes('agency') ? 'agency' : 'pro';
        const email = data.purchase?.email || '';
        const lics = loadLicenses();
        lics[code.toLowerCase()] = {
          code,
          email,
          created: new Date().toISOString(),
          plan,
          source: 'gumroad-api',
          uses: data.uses
        };
        saveLicenses(lics);
        console.log(`[gumroad-verify] Verified Gumroad license ${code} (${plan}) for ${email}`);
        return res.json({
          valid: true,
          plan,
          code,
          email,
          source: 'gumroad'
        });
      }
    } catch (e) {
      // Gumroad API unreachable, fallback
    }
  }

  res.json({ valid: false, plan: 'none' });
});

// Payment configuration endpoints (Gumroad)
app.get('/api/payment-config', (_req, res) => {
  const cfg = loadPaymentConfig();
  res.json({
    gumroad: {
      proUrl: cfg.gumroad.proUrl,
      agencyUrl: cfg.gumroad.agencyUrl,
      proPermalink: cfg.gumroad.proPermalink,
      agencyPermalink: cfg.gumroad.agencyPermalink,
      configured: !cfg.gumroad.proUrl.includes('clipbest-pro')
    },
    mode: cfg.mode
  });
});

app.post('/api/payment-config', (req, res) => {
  const cfg = loadPaymentConfig();
  if (req.body.gumroadProUrl) cfg.gumroad.proUrl = String(req.body.gumroadProUrl).trim();
  if (req.body.gumroadAgencyUrl) cfg.gumroad.agencyUrl = String(req.body.gumroadAgencyUrl).trim();
  if (req.body.gumroadProPermalink) cfg.gumroad.proPermalink = String(req.body.gumroadProPermalink).trim();
  if (req.body.gumroadAgencyPermalink) cfg.gumroad.agencyPermalink = String(req.body.gumroadAgencyPermalink).trim();
  if (req.body.mode) cfg.mode = String(req.body.mode).trim();
  savePaymentConfig(cfg);
  console.log('[payment] Updated Gumroad configuration:', cfg);
  res.json({ success: true, config: cfg });
});

// Checkout Routing: Gumroad or Instant Sandbox Provisioning
app.post('/api/checkout', (req, res) => {
  const plan = req.body.plan === 'agency' ? 'agency' : 'pro';
  const email = String(req.body.email || 'creator@clipbest.local').trim();
  const cfg = loadPaymentConfig();

  const rawUrl = plan === 'agency' ? cfg.gumroad.agencyUrl : cfg.gumroad.proUrl;
  const encodedEmail = encodeURIComponent(email);
  const gumroadUrl = rawUrl.includes('?') ? `${rawUrl}&email=${encodedEmail}` : `${rawUrl}?email=${encodedEmail}`;

  return res.json({
    success: true,
    provider: 'gumroad',
    redirect: gumroadUrl,
    rawUrl,
    plan,
    email
  });
});

// Gumroad Ping Webhook (Fires automatically on every purchase)
app.post('/api/webhooks/gumroad', (req, res) => {
  const payload = req.body || {};
  const email = String(payload.email || payload.buyer_email || payload.customer_email || 'customer@gumroad.com').trim();
  const permalink = String(payload.permalink || payload.product_permalink || payload.product_name || '').toLowerCase();
  const plan = permalink.includes('agency') ? 'agency' : 'pro';

  // Use Gumroad's auto-generated license key or generate a unique ClipBest key
  const licenseKey = String(payload.license_key || '').trim() || `CLIP-${plan.toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const lics = loadLicenses();
  lics[licenseKey.toLowerCase()] = {
    code: licenseKey,
    email,
    created: new Date().toISOString(),
    plan,
    source: 'gumroad',
    saleId: payload.sale_id || null,
    price: payload.price || null,
    refunded: payload.refunded === 'true' || payload.refunded === true
  };
  saveLicenses(lics);

  console.log(`[gumroad-ping] Provisioned ${plan} license ${licenseKey} for ${email}`);
  res.json({ success: true, code: licenseKey, plan, email });
});

// General payment webhook fallback
app.post('/api/webhooks/payment', (req, res) => {
  const secret = process.env.CLIPBEST_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized webhook' });
  }

  const email = req.body?.data?.attributes?.user_email || req.body?.customer_email || req.body?.email || 'customer@example.com';
  const newCode = `CLIP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const lics = loadLicenses();
  lics[newCode.toLowerCase()] = {
    code: newCode,
    email,
    created: new Date().toISOString(),
    plan: 'pro',
  };
  saveLicenses(lics);

  console.log(`[licenses] Generated new Pro license: ${newCode} for ${email}`);
  res.json({ success: true, code: newCode });
});

// Server system status
const PORT = process.env.PORT || 3000;
app.get('/api/status', (_req, res) => {
  const p = serverProvider();
  res.json({
    provider: p, label: LABELS[p], ai: p !== 'free', styles: Object.keys(STYLES),
    freeClips: FREE_CLIPS, maxClips: MAX_CLIPS, captionStyles: Object.keys(CAPTION_STYLES),
    formats: Object.keys(FORMATS), framings: ['fit', 'fill', 'split'],
  });
});

detectEncoder().then(() => app.listen(PORT, () => {
  const p = serverProvider();
  console.log(`ClipBest running -> http://localhost:${PORT}  (default hooks: ${p === 'free' ? 'basic free mode - set GEMINI_API_KEY for free AI hooks' : LABELS[p] + ' ' + MODELS[p]}; encoder: ${ENCODER.name})`);
}));
