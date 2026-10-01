// Records a demo video of a full order: customer chat + owner dashboard.
// Usage: npm run record-demo   → saves demo/whatsapp-order-bot-demo.mp4
// Needs Google Chrome and ffmpeg installed.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'demo');
const ORDERS = path.join(ROOT, 'data', 'orders.json');
const PORT = 4455;
const URL = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CTA = process.env.DEMO_CTA || 'Want this for your business? Send me a DM.';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Record against an empty order list, then put the real one back.
  const backup = fs.existsSync(ORDERS) ? fs.readFileSync(ORDERS) : Buffer.from('[]');
  fs.writeFileSync(ORDERS, '[]');

  const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    await wait(800);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const rawDir = fs.mkdtempSync(path.join(OUT_DIR, 'raw-'));

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const size = { width: 1280, height: 800 };
    const context = await browser.newContext({ viewport: size, recordVideo: { dir: rawDir, size } });
    await context.addInitScript(() => { try { localStorage.setItem('simStarted', '1'); localStorage.setItem('dashTab', 'orders'); localStorage.setItem('dashFilter', 'active'); localStorage.setItem('dashSound', 'off'); } catch {} }); // we'll type "Hi" ourselves
    const t0 = Date.now();
    const page = await context.newPage();
    await page.goto(URL);

    await page.addStyleTag({
      content: `#cap{position:fixed;left:440px;right:40px;bottom:48px;background:rgba(7,94,84,.95);color:#fff;
        font:600 22px -apple-system,Segoe UI,sans-serif;padding:14px 26px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.25);
        z-index:99;text-align:center}
        #card{position:fixed;inset:0;background:#075e54;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:14px;z-index:100;font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding:40px;transition:opacity .5s}
        #card h1{font-size:46px;margin:0}#card p{font-size:24px;margin:0;opacity:.9}`,
    });

    const card = (title, sub) =>
      page.evaluate(([t, s]) => {
        let c = document.getElementById('card');
        if (!c) { c = document.createElement('div'); c.id = 'card'; document.body.appendChild(c); }
        c.style.opacity = 1;
        c.innerHTML = `<h1>${t}</h1><p>${s}</p>`;
      }, [title, sub]);
    const hideCard = () => page.evaluate(() => { const c = document.getElementById('card'); c.style.opacity = 0; setTimeout(() => c.remove(), 500); });
    const caption = (text) =>
      page.evaluate((t) => {
        let c = document.getElementById('cap');
        if (!c) { c = document.createElement('div'); c.id = 'cap'; document.body.appendChild(c); }
        c.textContent = t;
      }, text);

    const say = async (text, pause = 1700) => {
      await page.click('#input');
      await page.type('#input', text, { delay: 55 });
      await wait(250);
      await page.keyboard.press('Enter');
      await wait(pause);
    };
    const dash = async (name, pause = 2200) => {
      await page.frameLocator('iframe').getByRole('button', { name, exact: true }).click();
      await wait(pause);
    };

    // ---- The script ----
    await card('Never miss a WhatsApp order again', 'An automatic order assistant for your food business');
    const trim = ((Date.now() - t0) / 1000).toFixed(2);
    await wait(3000);
    await hideCard();
    await wait(600);

    await caption('Step 1 · A customer says hi. The bot replies instantly, even at 2am');
    await say('Hi', 2600);

    await caption('Step 2 · They browse the menu and pick what they want');
    await say('1', 2400);
    await say('1', 1200);
    await say('2', 1800);
    await say('7', 1200);
    await say('2', 1800);

    await caption('Step 3 · Checkout: name, delivery or pickup, address');
    await say('C', 1300);
    await say('Tunde Bakare', 1500);
    await say('1', 1300);
    await say('Plot 5, Admiralty Way, Lekki Phase 1', 2600);

    await caption('Step 4 · The order total and payment details are sent automatically');
    await say('1', 3200);

    await caption('The order lands on the owner’s dashboard straight away');
    await wait(2800);

    await caption('One click, and the customer gets an update on WhatsApp');
    await dash('Confirm payment');
    await dash('Start preparing');
    await dash('Send out for delivery', 2600);

    await caption('No missed messages. No mix-ups. More sales.');
    await page.frameLocator('iframe').getByRole('button', { name: /^All ·/ }).click();
    await wait(600);
    await dash('Mark delivered', 2800);

    await card('Your 24/7 WhatsApp sales assistant', CTA);
    await wait(4000);

    await context.close(); // flushes the video file
    const raw = fs.readdirSync(rawDir).find((f) => f.endsWith('.webm'));
    const mp4 = path.join(OUT_DIR, 'whatsapp-order-bot-demo.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', trim, '-i', path.join(rawDir, raw),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4]);
    fs.rmSync(rawDir, { recursive: true, force: true });
    console.log('🎬 Saved', mp4);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.writeFileSync(ORDERS, backup);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
