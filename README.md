# Kingdom To The Counties — Ambassador Companion

A lightweight, no-login companion app for K2C ambassadors. Everyone shares one
live view: checklist, announcements, check-ins, headcount, praises, and feedback
all stay in sync across phones within a few seconds.

## How it works

- **`index.html`** — the entire app (front end).
- **`assets/`** — images, the counselor booklet PDF, and self-hosted fonts. These
  used to be base64-embedded in `index.html` (which made it ~3 MB); keeping them
  as separate files keeps the page small and lets the browser cache them.
- **`netlify/functions/data.mjs`** — the sync backend, built on [Netlify Blobs](https://docs.netlify.com/blobs/overview/). All phones read and write one shared record in the cloud.
- **`netlify.toml`** — tells Netlify where the site and functions live.
- **`package.json`** — lists the `@netlify/blobs` dependency.

## Ambassador Quick Capture (v1.7.0)

Under **Ambassador Resources → 📇 Quick Capture** (also one tap from the Event
Day page): a frictionless way for ambassadors on the street to capture an
encounter and move on, in one of **three lanes** — 📷 a photo of a filled-out
physical contact card, 🎙️ a recorded voice note, or ⌨️ a typed entry. Pop-up
reminders enforce the minimum the follow-up team needs: **name, contact info
(phone or email), and notes on the encounter** — typed entries require all
three; card-photo and voice-note submissions get a "does your photo/recording
cover these?" confirmation instead, so nothing blocks a fast capture.

Captures sync to the shared backend (destined for Planning Center Online — the
CRM push is a later build). Privacy & resilience:

- The polling payload only carries a **count** — the records themselves (names,
  phones, emails, notes) are fetched with the **leader PIN** (`capturesList`),
  and photo/audio blobs are stored per-capture and fetched on demand
  (`captureMedia`). Leaders can review, listen/view, **export a CSV**, and
  delete captures once they're entered into Planning Center.
- No signal? Captures queue in the phone's local storage and **auto-send when
  the app is back online** (server-side idempotency means a retry can't
  double-submit). The "Captured from this phone" list shows sent/waiting state.
- Photos are downscaled client-side (≤1400 px JPEG) and voice notes cap at 3
  minutes so submissions stay field-signal friendly.
- Captures **survive the end-of-day reset** — like issues, they're not
  day-scoped data.

## Recording Studio (Teleprompter)

Under **Ambassador Resources → 🎬 Recording Studio**: invite-video scripts for
every county, each with a due date and assignee, opening into a full-screen
camera teleprompter (adjustable font/speed, 3-2-1 countdown, in-browser
recording, save/share). Viewing and recording is open to anyone past the Day
PIN; **adding/editing scripts, due dates, and assignees is leader-PIN only**
(that's Laura's board). After recording, the app reminds the filmer to save the
video and send it to Laura, then mark the script ✅ done with their initials.

An empty board shows leaders a **Load starter scripts** button that seeds A/B/C
scripts for all counties (Sullivan ships with `[DATE]`/`[VENUE]` placeholders —
edit once confirmed).

The script editor (v1.7.0) is dropdown-driven — no typing county/venue strings:
the **county/event** is a dropdown of all 8 counties (plus "Other / custom"),
the **assignee** is a dropdown of the leader roster (plus "Other…" for anyone
else), and a **template picker offers 10 versions of every script** (Come As
You Are, Logistics/Urgency, Pain Point/Hope, Personal Testimony, Family & Kids,
For the Skeptic, Come Back Home, Young Adults, Bring Someone, Final Call) that
fill the title + body with the chosen county's date and venue — and every
generated script stays fully editable.

Every phone re-reads the shared state every 5 seconds (re-rendering only when
something actually changed), so updates show up for everyone within a few
seconds. No accounts, no separate database to set up — Netlify enables Blobs
automatically on deploy.

## Security & data model (v20)

- **Leader PIN is verified server-side** on every privileged action (checklists,
  announcements, event/day-PIN/funding settings, reset, script editing). Rotate
  it by setting a `LEADER_PIN` environment variable in Netlify and redeploying —
  the code fallback is only used when the variable is unset.
- **The Day PIN is never sent to clients.** The API only reports whether one is
  set; entered PINs are verified server-side.
- **PIN guessing is rate-limited.** 15 wrong PIN entries in 10 minutes from one
  IP blocks further PIN checks (HTTP 429) until the window slides past. Empty
  PINs never count and a correct leader PIN clears the record, so shared event
  WiFi and morning-huddle typos won't lock real volunteers out.
- **The Recording Studio board self-seeds.** Starter scripts for all 8 counties
  are merged into the shared board on read, so every user sees every county
  without a leader having to seed anything; a script a leader deletes is
  tombstoned and stays deleted.
- **Storage is split by domain** (`core`, `checkins`, `io`, `prompter`, plus one
  `count-<device>` / `tally-<device>` shard per phone) so concurrent writes can't
  clobber each other. Old single-blob data migrates automatically on first read.
- **Shared blobs use compare-and-swap.** Every read-modify-write on `core` and
  friends re-reads the current value + etag and writes only-if-unchanged,
  retrying on a conflict. Two leaders toggling different checkmarks at the same
  instant both stick (the pre-v20 last-write-wins was the cause of checkmarks
  that "only occasionally" saved).
- **The head count is O(1) to read.** Taps still land in per-phone shards (never
  lost), but a cached `count-agg` blob is kept in sync incrementally, so a `GET`
  reads one blob instead of listing + fetching every device shard. It rebuilds
  itself from the shards whenever it goes missing, so it can't be wrong for long.
- **Counter taps are pushed as absolute per-phone tallies (v1.6.0).** Each phone
  keeps its own running tally in `localStorage` and pushes the whole thing
  (`tallySet` → `tal2-<device>` shard): "my total is N, split by name". A retried
  request can't double-count and a dropped one can't lose taps — the next push
  carries them, even across a page reload. A leader reset rotates a `tallyEpoch`
  so phones holding a pre-reset tally clear it instead of re-pushing old numbers.
  (Legacy `count-`/`tally-` delta shards from older clients still sum in.)
- **Polls are cheap.** `GET` returns a weak `ETag`; clients send `If-None-Match`
  and get a bodyless `304` (and skip re-rendering) whenever nothing changed.
- **User-submitted content is normalized server-side** — feedback, praise,
  announcements, check-ins and comments have their fields whitelisted, lengths
  capped, and `priority`/`pri` validated against a fixed set. Clients can't
  inject markup through a priority class or pre-set a report as acknowledged.
- **`sw.js`** is a network-first service worker: online behavior is identical to
  having no cache (fresh deploys always win), but if the field signal drops the
  app shell, fonts, and images still load.

## Hosting (Netlify)

This repo is set up for automatic deploys: connect it to a Netlify site and
every push to `main` rebuilds and publishes the site.

1. In Netlify: **Add new site → Import an existing project → Deploy with GitHub**
2. Pick this repository.
3. Build settings come from `netlify.toml` (publish `.`, functions `netlify/functions`).
4. Deploy.

## Checking it's live

Open the site and look at the little pill near the top:

- **"Live — synced to everyone"** = working
- **"Demo mode — deploy to sync"** = the function isn't reachable yet

## Local development

Requires [Node.js](https://nodejs.org). Then:

```bash
npm install
npx netlify dev
```

## Contributing

Push changes to a branch and open a pull request, or commit to `main` to deploy.
