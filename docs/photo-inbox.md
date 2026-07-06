# Photo Inbox — email photos from your phone to the Pi

There's no LiteLayer phone app, and there doesn't need to be: every phone
already knows how to email a photo. The Photo Inbox watches an email address
and saves incoming photo attachments straight onto a drive — optionally sorted
into folders by a small AI model running entirely on the Pi.

## Setup (5 minutes)

1. **Make a mailbox for the Pi.** A fresh Gmail address works best
   (e.g. `mypi.photos@gmail.com`), so your personal inbox is never touched.
2. In that Google account: turn on **2-Step Verification**, then create an
   **App password** (myaccount.google.com/apppasswords).
3. In LiteLayer → **Settings → Photo Inbox**: enter `imap.gmail.com`, port
   `993`, the address, and the app password. Hit **Test connection**.
4. Pick the destination drive + folder, add your **allowed senders**
   (your personal email addresses), and turn the inbox on.
5. On your phone: select photos → Share → Mail → send to the Pi's address.
   They appear on the drive within a minute.

Any IMAP provider works (iCloud, Outlook, Fastmail…) — just swap the server.

## Texting photos instead

No extra service needed: US carriers deliver an MMS sent **to an email
address** as ordinary email. In your Messages app, put the Pi's email address
in the To field, attach the photo, send. It arrives from
`yournumber@your-carrier's-gateway` (T-Mobile: `tmomail.net`, Verizon:
`vzwpix.com`; AT&T shut its gateway down in 2025, so AT&T phones must use the
email path). Text yourself one photo first — the status line will show
"blocked: 15551234567@tmomail.net…", which tells you the exact address to add
to **allowed senders**. Adding the whole domain (`@tmomail.net`) lets every
phone on that carrier in, so use the full number@domain form unless you mean it.
If the status line instead shows a DKIM/SPF block for the carrier, that
carrier's gateway mail can't be verified — only then, consider turning
*Require verified senders* off.

## Security — two gates, in order

1. **Allowed senders** — mail from any other From address is ignored. With the
   list empty, only mail from the Pi's own address counts.
2. **Verified senders (on by default)** — a From address alone can be faked,
   so LiteLayer also requires the mail to have passed your provider's own
   DKIM/SPF authenticity check (the `Authentication-Results` verdict Gmail
   stamps on every inbound message). A spoofer can't cryptographically sign
   for a domain they don't control, so a faked From fails here.

Plus: only image/video attachments are ever saved (jpg, png, heic, mov, …) —
never executables or documents — filenames are stripped to their basename, and
the app password is stored Fernet-encrypted on the Pi. Rejected mail shows up
in the status line ("blocked: …") so a misconfigured gate is visible, not silent.

## How mail is processed

- Each poll handles only the **2 newest unread mails** (older unread mail
  drains on the following polls), so a big inbox never triggers a mass scan.
- A mail with a **subject line** puts its photos into a folder of that name
  (created if needed) — subject beats AI sorting. No subject → AI/root.
- Every photo gets an **id** (its content hash, kept in `.ll-photo-ids.json`
  next to the photos). Re-sending the same image is skipped — no duplicates,
  and nothing is ever overwritten.
- Photo Inbox **never deletes anything**: not your photos, not your mail
  (messages are only marked as read).

## AI sorting

Optional, off by default, one-time ~170 MB install (Settings → Photo Inbox →
*Install AI model*). It's **CLIP ViT-B/32** (quantized ONNX, Xenova export)
running on the Pi's CPU — about a second per photo on a Pi 4/5, no cloud, no
GPU, no training.

You define folders with plain-language hints ("receipts and documents",
"family and friends", "screenshots"). Each arriving photo is matched against
your hints zero-shot; low-confidence photos land in `Unsorted` instead of
being guessed at.

## Why not AirDrop / Bluetooth?

iPhones cannot send files over Bluetooth to non-Apple hardware at all, and
Android's Nearby Share has no Linux receiver worth depending on. Email works
on every phone with zero pairing — that's the whole trick. (The web UI upload
button covers the on-your-own-WiFi case.)
