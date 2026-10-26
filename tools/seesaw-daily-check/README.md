# Seesaw daily check

A scheduled Claude task runs every day in the afternoon (Gulf time), signs
into the Seesaw family account, reads everything new for the child
(notifications, announcements, messages, journal posts, activities, events)
and sends back a short brief split into:

1. **Action needed now** – deadlines today/tomorrow, forms, payments, things
   to bring, RSVPs, replies the teacher is waiting for.
2. **Action this week** – everything with a later deadline.
3. **FYI** – journal posts, photos, likes, general announcements with no ask.

## One-time setup (done in the cloud environment settings, not in chat)

Open the cloud environment menu in the session title bar, choose **Edit**:

1. **Network access** – add these hosts under *Allowed domains* (or pick a
   broader access level). Keep *Allow package managers* ticked.
   - `app.seesaw.me`
   - `seesaw.me` and its subdomains (`*.seesaw.me`)
   - If screenshots come back blank, add the hosts listed under
     `blockedHosts` in the run's `manifest.json` (Seesaw serves media from
     a CDN).
2. **Secrets / environment variables** – add
   - `SEESAW_EMAIL` – the family account's sign-in email
   - `SEESAW_PASSWORD` – its password
   - `SEESAW_TZ` – optional, defaults to `Asia/Dubai`

   The family account must sign in with email + password. Google/Apple
   sign-in and QR-code sign-in cannot be automated here.

Never paste the password into a chat message; the collector only reads it
from the environment.

## Running the collector by hand

```bash
node tools/seesaw-daily-check/collect.js /path/to/output-dir
```

Exit codes: `0` collected, `1` credentials missing, `2` login rejected,
`3` Seesaw unreachable (network policy), `4` unexpected error. `run.log`
in the output folder says why.

The output folder holds the visible text, accessibility tree and a
screenshot of every section it found, plus every JSON response the Seesaw
app fetched (`api/`), which usually carries the structured notification and
message data. `state.json` is a reusable logged-in browser state for a
follow-up Playwright session.

The collector has no knowledge of Seesaw's internal page structure beyond a
few guesses, so it is deliberately broad: it captures what a parent sees and
leaves the reading to the summarisation step.
