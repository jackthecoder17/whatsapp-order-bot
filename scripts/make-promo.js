// Renders scripts/promo/promo.html frame by frame into a vertical promo video with sound.
// Usage: npm run promo            → demo/promo-vertical.mp4 (1080×1920, 30fps)
//        PROMO_CTA="WhatsApp 0909 000 0000" npm run promo
// Needs Google Chrome and ffmpeg.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo', 'promo-vertical.mp4');
const WAV = path.join(ROOT, 'demo', '.promo-audio.wav');
const FPS = 30;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ---------- sound effects (synthesised, no copyrighted audio) ----------
const RATE = 44100;
function buildAudio(cues, duration) {
  const buf = new Float32Array(Math.ceil(duration * RATE));
  const add = (t0, len, fn) => {
    const s0 = Math.floor(t0 * RATE);
    for (let i = 0; i < len * RATE && s0 + i < buf.length; i++) buf[s0 + i] += fn(i / RATE);
  };
  const tone = (f, t, decay, amp) => amp * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / decay);
  const sweep = (f0, f1, t, dur) => 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * dur));
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  const sfx = {
    send: (t0) => add(t0, .09, (t) => .32 * Math.sin(sweep(900, 1500, t, .09)) * Math.exp(-t / .03)),
    recv: (t0) => add(t0, .14, (t) => .30 * Math.sin(sweep(1300, 700, t, .14)) * Math.exp(-t / .045)),
    notif: (t0) => add(t0, .2, (t) => tone(1760, t, .05, .16) + tone(2640, t, .03, .06)),
    tap: (t0) => add(t0, .05, (t) => tone(2200, t, .008, .25)),
    pop: (t0) => add(t0, .2, (t) => .4 * Math.sin(sweep(300, 900, t, .2)) * Math.exp(-t / .06)),
    ding: (t0) => { add(t0, .9, (t) => tone(880, t, .35, .28) + tone(1760, t, .2, .08)); add(t0 + .13, .9, (t) => tone(1318.5, t, .4, .26)); },
    chime: (t0) => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => add(t0 + i * .085, .9, (t) => tone(f, t, .32, .16))),
    whoosh: (t0) => {
      let lp = 0;
      add(t0, .45, (t) => {
        const env = Math.sin(Math.PI * Math.min(1, t / .45));
        const a = .04 + .3 * (t / .45); // filter opens up through the sweep
        lp += a * (noise() - lp);
        return .55 * env * env * lp;
      });
    },
  };
  for (const c of cues) sfx[c.k]?.(c.t);

  // gentle limiter + 16-bit WAV
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const gain = peak > .9 ? .9 / peak : 1;
  const data = Buffer.alloc(buf.length * 2);
  buf.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * gain)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(WAV, Buffer.concat([h, data]));
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'promo', 'promo.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => window.PROMO);
  if (process.env.PROMO_CTA) await page.evaluate((s) => window.PROMO.setCta(s), process.env.PROMO_CTA);

  const { DURATION, CUES } = await page.evaluate(() => ({ DURATION: window.PROMO.DURATION, CUES: window.PROMO.CUES }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  buildAudio(CUES, DURATION);

  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-i', WAV,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(DURATION * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.PROMO.render(t), i / FPS);
    const shot = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(shot)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) process.stdout.write(`  frame ${i}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exited ' + c)))));
  await browser.close();
  fs.rmSync(WAV, { force: true });
  console.log('🎬 Saved', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
