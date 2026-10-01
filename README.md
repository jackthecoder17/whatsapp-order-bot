# WhatsApp Order Bot 🍲

A WhatsApp food-ordering bot for small businesses: menu → cart → checkout → payment → live order updates, plus an owner dashboard.

## Run the demo (no WhatsApp account needed)

```bash
npm start
```

Open http://localhost:3000. The left side is a WhatsApp-style phone and the right side is the owner dashboard. Place an order on the phone, then move it through **Confirm payment → Start preparing → Out for delivery → Delivered** on the dashboard. The customer gets a message at every step.

The owner dashboard on its own is at http://localhost:3000/dashboard. It's built for phones.

## Owner dashboard
- **Orders:** today's stats, filters (Active / Awaiting payment / Completed / Cancelled / All), search, a progress bar, one-tap status buttons, and WhatsApp/Call links for each customer
- **Alerts:** a sound, a pop-up and a flashing tab title for new orders and "talk to a person" requests (toggle with 🔔)
- **Chats:** every conversation, with replies sent from the dashboard straight to the customer's WhatsApp, and a "Hand back to bot" button
- **Menu:** mark items sold out (hidden from customers), change prices, add or remove items. Changes are saved to `config.json`
- **Login:** set `DASHBOARD_PASSWORD` to require a password. The server refuses to connect to WhatsApp without one.

## Record a demo video

```bash
npm install
npm run record-demo
```

This saves `demo/whatsapp-order-bot-demo.mp4`, a ~50-second video of a full order with captions. It uses the menu in `config.json`, so re-run it after changing the business. Set `DEMO_CTA="Call 0801 234 5678"` to change the closing line. It needs Google Chrome and ffmpeg.

## Customise for a client

Edit `config.json` to set the business name, hours, location, delivery fee, bank details and menu. No code changes are needed.

## Features
- Numbered menu (works on any phone, no buttons required)
- Cart with quantities, delivery or pickup, address capture
- Order summary + bank-transfer details (optional Paystack payment link)
- Automatic customer updates when the owner changes the order status
- Order tracking (reply `4`)
- "Talk to a person" hand-off (bot goes quiet, owner is alerted)
- New-order alerts to the owner's WhatsApp
- Keywords: `menu`, `hi`, `0` (main menu), `cancel`

## Test on your own phone (real WhatsApp, free)

Meta gives every developer a free **test WhatsApp number** that can message up to 5 phone numbers you verify.

**1. Meta setup (one time, ~10 min)**
1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create app** → choose **Other**, then **Business** → give it a name.
2. On the app page, find **WhatsApp** and click **Set up**. Pick or create a business portfolio.
3. Open **WhatsApp → API Setup**. You'll see:
   - a **test phone number** (the bot's number)
   - the **Phone number ID**, which you'll need
   - a **temporary access token** (click *Generate*; it lasts 24 hours)
4. Under **To**, add **your own phone number** and enter the code WhatsApp sends you.

**2. Fill in `.env`**
```bash
cp .env.example .env
```
Put the token and phone number ID in `.env`, choose a `WHATSAPP_VERIFY_TOKEN` phrase and a `DASHBOARD_PASSWORD`, and set `OWNER_WHATSAPP` to your number (e.g. `2348012345678`).

**3. Start the bot** (terminal 1)
```bash
npm run live
```

**4. Give it a public HTTPS address** (terminal 2)
```bash
cloudflared tunnel --url http://localhost:3000
```
Copy the `https://….trycloudflare.com` address it prints. It changes every time you restart the tunnel.

**5. Connect the webhook**: Meta → **WhatsApp → Configuration → Webhook → Edit**
- Callback URL: `https://….trycloudflare.com/webhook`
- Verify token: the same phrase as `WHATSAPP_VERIFY_TOKEN`
- Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.

**6. Test:** on your phone, send **hi** to the test number on WhatsApp. Open `https://….trycloudflare.com/dashboard` on your phone to manage orders.

**Troubleshooting**
- *No reply:* check terminal 1. `WhatsApp send failed: 401` means the token expired (get a new one and restart). `(#131030) Recipient phone number not in allowed list` means you need to add your number under **To** in API Setup.
- *Webhook won't verify:* the bot must be running, the tunnel URL must end in `/webhook`, and the verify token must match exactly.
- *Owner alerts don't arrive:* WhatsApp only allows free-text messages within 24 hours of that number messaging the bot. Send the bot a message from the owner's phone first.

## Going live for a client

1. Use the client's own number: in Meta, **API Setup → Add phone number** (it can't be registered in the normal WhatsApp app at the same time).
2. Create a **permanent token**: Business Settings → **System users** → add one → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`.
3. Deploy this folder to a server with HTTPS (Render, Railway or a VPS) and set the same `.env` values there.
4. Point the webhook at `https://your-domain/webhook`.

## Files
| File | Purpose |
|---|---|
| `bot.js` | Conversation logic (the "brain") |
| `server.js` | Web server, dashboard API, WhatsApp webhook |
| `store.js` | Saves orders to `data/orders.json` |
| `config.json` | Business details and menu |
| `public/dashboard.html` | Owner dashboard (orders, chats, menu) |
| `public/index.html` | Demo page: phone simulator + embedded dashboard |
| `scripts/record-demo.js` | Records the demo video |
