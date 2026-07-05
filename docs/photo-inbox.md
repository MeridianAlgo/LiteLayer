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

## Security

- Only mail from **allowed senders** is processed; everything else is ignored.
  With the list empty, only mail from the Pi's own address counts.
- Only image/video attachments are saved (jpg, png, heic, mov, …) — never
  executables or documents.
- The app password is stored Fernet-encrypted on the Pi, same as your synced
  settings. Note the From header is not authenticated mail — anyone who knows
  an allowed sender's address could spoof it. A dedicated, unguessable Gmail
  address for the Pi is the real gate; don't reuse a public inbox.

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
