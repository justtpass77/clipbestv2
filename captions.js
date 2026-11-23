// Caption + hook-title rendering as ASS subtitles (burned in by ffmpeg's ass filter).

const assTime = ms => {
  const cs = Math.max(0, Math.round(ms / 10));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

const assSafe = s => String(s || '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();

// '#RRGGBB' (+ alpha 00 = opaque, FF = invisible) -> ASS '&HAABBGGRR'
const assColor = (hex, alpha = '00') => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

// Caption presets. `hi` = word highlight colour (overridable by the user), `base` = unspoken words.
// Fonts must exist on the machine that renders (these ship with Windows).
const CAPTION_STYLES = {
  classic: {   // bold uppercase, yellow karaoke, hook on a white card
    font: 'Arial Black', size: 84, upper: true, words: 3, hi: '#FFE500', base: '#FFFFFF',
    border: 1, outline: 7, shadow: 2, marginV: 520,
    hook: { font: 'Arial', size: 66, text: '#101010', box: '#FFFFFF', border: 3, outline: 16, marginV: 330 },
  },
  bold: {      // big punchy Impact, two words at a time, outlined hook - gaming / hype edits
    font: 'Impact', size: 112, upper: true, words: 2, hi: '#3DFF6E', base: '#FFFFFF',
    border: 1, outline: 9, shadow: 0, marginV: 460,
    hook: { font: 'Impact', size: 84, text: '#FFFFFF', box: '#000000', border: 1, outline: 6, marginV: 300 },
  },
  clean: {     // sentence case on a soft dark pill - podcasts / talking heads
    font: 'Segoe UI Semibold', size: 74, upper: false, words: 4, hi: '#7DD3FC', base: '#FFFFFF',
    border: 3, outline: 14, shadow: 0, marginV: 480, boxAlpha: '50',
    hook: { font: 'Segoe UI Semibold', size: 66, text: '#FFFFFF', box: '#111111', border: 3, outline: 18, marginV: 320, boxAlpha: '30' },
  },
};

// Where captions + hook sit for a given output size and framing.
// Style margins are tuned for 1080x1920 "fit" (16:9 video centred, blurred bands above/below);
// for other layouts we keep the same distance from the video edge, or use thirds when the
// video fills the frame.
function placement(st, { W, H, fit }) {
  const scale = Math.min(W, H) / 1080 * (H < W ? 0.9 : 1);
  const BASE_BAND = (1920 - 1080 * 9 / 16) / 2;          // 656: band height in the 9:16 baseline
  const band = fit ? (H - W * 9 / 16) / 2 : 0;           // band height in this layout
  if (band > H * 0.15) {
    return {
      scale,
      capV: Math.max(Math.round(H * 0.06), Math.round(band - (BASE_BAND - st.marginV))),
      hookV: Math.max(Math.round(H * 0.05), Math.round(band - (BASE_BAND - st.hook.marginV))),
    };
  }
  // video fills (or nearly fills) the frame: captions in the lower third, hook near the top
  return { scale, capV: Math.round(H * 0.2), hookV: Math.round(H * 0.1) };
}

function buildAss(words, startSec, endSec, hook, styleName = 'classic', hiColor = null, layout = { W: 1080, H: 1920, fit: true }, watermark = false, customBrand = null) {
  const st = CAPTION_STYLES[styleName] || CAPTION_STYLES.classic;
  const ws = (words || []).filter(w => w.start >= startSec * 1000 && w.start < endSec * 1000);
  if (!ws.length && !hook && !watermark && !customBrand) return null;
  let ev = '';
  const durMs = (endSec - startSec) * 1000;
  if (customBrand) {
    ev += `Dialogue: 2,0:00:00.00,${assTime(durMs)},Watermark,,0,0,0,,{\\b1}${assSafe(customBrand)}{\\b0}\n`;
  } else if (watermark) {
    ev += `Dialogue: 2,0:00:00.00,${assTime(durMs)},Watermark,,0,0,0,,{\\i1}⚡ Made with Clipbest{\\i0}\n`;
  }
  if (hook) ev += `Dialogue: 1,0:00:00.00,${assTime(durMs)},Hook,,0,0,0,,${assSafe(hook)}\n`;
  for (let i = 0; i < ws.length; i += st.words) {
    const chunk = ws.slice(i, i + st.words);
    const cs = chunk[0].start, ce = chunk[chunk.length - 1].end;
    const text = chunk.map(w => {
      const t = w.t.replace(/[{}\\]/g, '');
      return `{\\k${Math.max(1, Math.round((w.end - w.start) / 10))}}${st.upper ? t.toUpperCase() : t}`;
    }).join(' ');
    ev += `Dialogue: 0,${assTime(cs - startSec * 1000)},${assTime(ce - startSec * 1000)},Cap,,0,0,0,,${text}\n`;
  }
  const hi = assColor(hiColor || st.hi), base = assColor(st.base);
  // BorderStyle 3 draws an opaque box in OutlineColour; BorderStyle 1 draws a text outline.
  const capOutline = st.border === 3 ? assColor('#000000', st.boxAlpha || '00') : assColor('#000000');
  const h = st.hook;
  const hookOutline = assColor(h.box, h.boxAlpha || '00');
  const { capV, hookV, scale } = placement(st, layout);
  const fs = n => Math.round(n * scale);
  const wmSize = fs(32);
  const wmMarginV = Math.round(layout.H * 0.04);
  const wmMarginR = Math.round(layout.W * 0.04);

  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${layout.W}\nPlayResY: ${layout.H}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
    `Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n` +
    `Style: Cap,${st.font},${fs(st.size)},${hi},${base},${capOutline},&H80000000,-1,0,0,0,100,100,0,0,${st.border},${fs(st.outline)},${st.shadow},2,60,60,${capV},1\n` +
    `Style: Hook,${h.font},${fs(h.size)},${assColor(h.text)},${assColor(h.text)},${hookOutline},${hookOutline},-1,0,0,0,100,100,0,0,${h.border},${fs(h.outline)},0,8,110,110,${hookV},1\n` +
    `Style: Watermark,Segoe UI Semibold,${wmSize},&H50FFFFFF,&H50FFFFFF,&H70000000,&H80000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, fs(3))},1,9,40,${wmMarginR},${wmMarginV},1\n\n` +
    `[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${ev}`;
}

module.exports = { buildAss, CAPTION_STYLES };
