# Pebble app setup

Do this after the Worker is deployed (`npm run deploy`) and you have its URL.

1. **Update the Pebble app to the latest App Store build first.** Older
   versions may not support custom auth headers on the webhook.

2. **Button/gesture destination** (recommended): Settings → Hold & talk →
   set destination to **"Webhook only"** ("Raw recording to your endpoint,
   nothing else"). Transcription still runs and the webhook still fires —
   this destination just skips creating a duplicate note/reminder in the
   app's own agent, so you get the natural hold-and-talk gesture with no
   duplication.

   If your installed build doesn't offer "Webhook only" as a destination,
   put the webhook on **double-click & hold** instead, and leave hold & talk
   on the built-in agent.

3. **Index 01 Settings → Webhook:**
   - **URL**: `https://<your-worker>.workers.dev/index-webhook`
     (or your custom domain, if you set one up)
   - **Headers** — add one row:
     - **Name**: `Authorization`
     - **Value**: `Bearer <the token you generated>` (the word "Bearer",
       one space, then the token — all in the Value field. The #1 mistake
       here is putting `Bearer` in the Name field instead, which sends a
       literal `Bearer:` header and no `Authorization` header at all —
       instant 401s.)
   - **Payload mode**: **Both** ("Recording only" sends zero transcription
     text, which this Worker also accepts but you'll lose the fast text
     record.)

4. **Send test event.** This exercises the URL and auth with no real
   recording — canned text, no audio, and the Worker deliberately does not
   file it as a note. Confirm it shows `200` / success in the app's webhook
   screen. If you have `npx wrangler tail` running, you should see:
   ```json
   {"event":"test_event_received"}
   ```

5. **Record a real note** (hold & talk, or whichever gesture you configured)
   and confirm within a minute or two:
   - The app's **Recent runs** list under Webhook settings shows a
     successful delivery.
   - A matching `.m4a` + `.txt` pair appears in the Drive folder.

## If something's wrong

- **Every delivery is 401**: almost always the Authorization header — check
  it's `Name: Authorization`, `Value: Bearer <token>`, not split any other
  way.
- **Recent runs shows failures but nothing in `wrangler tail`**: the app may
  not have had network access at delivery time — it retries on the next
  recording, so record again. If it's still failing, re-check the URL for a
  typo (must end in `/index-webhook`).
- **Note appears with no transcription**: payload mode is set to "Recording
  only" — switch to "Both".
