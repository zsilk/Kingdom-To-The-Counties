import { getStore } from "@netlify/blobs";
// Starter teleprompter scripts. Missing ones are merged into the live board
// automatically on read, so every user sees every county without a leader
// having to seed anything. Generated from data/scripts.json — regenerate with
// `node scripts/sync-starter-scripts.mjs` after editing that file.
import STARTER_SCRIPTS from "./starter-scripts.mjs";

const STORE = "k2c-ambassador";
const DEFAULT_DAY_PIN = "0711";
// Leader PIN is verified SERVER-SIDE. Rotate it by setting a LEADER_PIN
// environment variable in Netlify (Site settings → Environment variables),
// then redeploying — no code change needed.
const LEADER_PIN = () => process.env.LEADER_PIN || "2026";

/* ---------------- storage layout ----------------
 v20 (app v1.4.0) — split-by-domain blobs + compare-and-swap writes:
 core      — checklist, announcements, feedback (issues + comments), praises,
             event, dayPin, funding
 checkins  — check-in list
 io        — Tech I/O roster + patch progress
 prompter  — Recording Studio scripts
 radios    — 10-radio checkout board (initials + times)
 captures  — Ambassador Quick Capture contact records (text fields only)
 capmedia- — one blob per capture holding its photo/audio as a data URL,
             fetched on demand by leaders (never included in the GET payload,
             so polling stays light and contact PII isn't broadcast to every
             phone — only a count is)
 count-    — LEGACY numeric counter shard per phone (still summed, still works)
 tally-    — LEGACY per-phone delta-built tally {total, by} (still summed)
 tal2-     — v1.6.0 per-phone ABSOLUTE tally {total, by:{name:n}}. The phone
             owns its shard and pushes its whole tally each time ("my total is
             N"), so a retried or dropped request can never double-count or
             lose taps the way lost "+1 deltas" could.
 tallyEpoch— {e} rotated on every reset; a phone whose stored epoch is stale
             gets told to clear its local tally instead of re-pushing
             pre-reset numbers.
 count-agg — CACHED {total, by} aggregate of every count-/tally- shard so a GET
             is one read instead of listing + fetching ~50 shards. Maintained
             incrementally on each tap and rebuilt from the shards whenever it
             is missing, so it is self-healing and can never be authoritative-
             wrong (the shards are).
 Every shared blob is now written through compareAndSwap(): read the current
 value + its etag, apply the change, write only-if-unchanged, and retry on a
 conflict. Two leaders toggling different checkmarks at the same instant can no
 longer clobber each other (the pre-CAS "last write wins" was the bug behind
 checkmarks that "only occasionally stuck").
 Old single-blob data migrates automatically on first read. */

const EMPTY_CORE = { checklist:{}, notes:{}, announcements:[], feedback:[], praises:[], event:{name:"",date:""}, dayPin:DEFAULT_DAY_PIN, funding:{pct:64, needed:"$60,000"} };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const str = (v, n) => (v == null ? "" : v.toString()).slice(0, n);

function ioListClearProgress(list){
 if(!Array.isArray(list) || !list.length) return list;
 return list.map(p => ({ ...p, rows: (p.rows || []).map(r => ({ ...r, done:false, by:"", t:"" })) }));
}

/* ---- user-submitted content is normalized server-side: fields are
   whitelisted, lengths capped, and priority/pri validated against a fixed set.
   This is authoritative — the client is never trusted to have escaped anything
   or to leave `hidden`/`ackBy` alone. Applied both when a new item is stored
   AND on every read, so any pre-existing junk is neutralized too. ---- */
const ISSUE_PRIOS = new Set(["low","med","urgent"]);
const ANN_PRIOS = new Set(["urgent","heads","info"]);

function normComments(list){
 if(!Array.isArray(list)) return [];
 return list.map(c => ({
  name: str((c && c.name) || "Volunteer", 40),
  text: str(c && c.text, 500),
  t: str(c && c.t, 12)
 })).slice(-100);
}
function normIssue(x){
 x = x || {};
 return {
  id: str(x.id, 40) || uid(),
  priority: ISSUE_PRIOS.has(x.priority) ? x.priority : "med",
  title: str(x.title, 140),
  body: str(x.body, 2000),
  by: str(x.by || "Volunteer", 40),
  t: str(x.t, 12),
  hidden: !!x.hidden,
  ackBy: str(x.ackBy, 40),
  ackT: str(x.ackT, 12),
  comments: normComments(x.comments)
 };
}
function normPraiseItem(x){
 x = x || {};
 return {
  id: str(x.id, 40) || uid(),
  name: str(x.name || "Anonymous", 40),
  body: str(x.body, 2000),
  t: str(x.t, 12),
  hidden: !!x.hidden,
  ackBy: str(x.ackBy, 40),
  ackT: str(x.ackT, 12),
  comments: normComments(x.comments)
 };
}
function normAnn(x){
 x = x || {};
 return {
  id: str(x.id, 40) || uid(),
  pri: ANN_PRIOS.has(x.pri) ? x.pri : "info",
  title: str(x.title, 140),
  body: str(x.body, 2000),
  by: str(x.by, 60),
  t: str(x.t, 12),
  comments: normComments(x.comments)
 };
}
/* ---- Ambassador Quick Capture ----
   A capture is one street encounter: name + contact + notes, optionally with a
   photo of a filled-out contact card or a voice memo. Text fields live in the
   `captures` list; media lives in its own capmedia-<id> blob (data URL). */
const CAPTURE_LANES = new Set(["photo","audio","text"]);
const CAPTURE_MEDIA_MAX = 5 * 1024 * 1024; // ~5 MB data URL (post-compression photos & <3 min voice notes fit easily)
function normCapture(x){
 x = x || {};
 return {
  id: str(x.id, 40) || uid(),
  lane: CAPTURE_LANES.has(x.lane) ? x.lane : "text",
  name: str(x.name, 80),
  phone: str(x.phone, 40),
  email: str(x.email, 80),
  county: str(x.county, 60),
  notes: str(x.notes, 4000),
  by: str(x.by || "Ambassador", 40),
  t: str(x.t, 12),
  d: str(x.d, 10),
  hasMedia: !!x.hasMedia,
  mediaKind: x.mediaKind === "photo" || x.mediaKind === "audio" ? x.mediaKind : ""
 };
}
const normCaptures = v => Array.isArray(v) ? v.map(normCapture).slice(-1000) : [];
const capMediaKey = id => "capmedia-" + (id || "").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 40);

function normCheckin(x){
 x = x || {};
 return {
  id: str(x.id, 40) || uid(),
  name: str(x.name, 40),
  team: str(x.team, 40),
  attested: !!x.attested,
  t: str(x.t, 12)
 };
}

export function normCore(c){
 c = c || {};
 return {
 checklist: c.checklist || {},
 notes: normNotes(c.notes),
 announcements: Array.isArray(c.announcements) ? c.announcements.map(normAnn).slice(0, 200) : [],
 feedback: Array.isArray(c.feedback) ? c.feedback.map(normIssue).slice(0, 500) : [],
 praises: Array.isArray(c.praises) ? c.praises.map(normPraiseItem).slice(0, 500) : [],
 event: c.event || { name:"", date:"" },
 // One-time migration: retire the old 0627 Day PIN in favor of 0711.
 dayPin: (typeof c.dayPin === "string" && c.dayPin !== "0627") ? c.dayPin : DEFAULT_DAY_PIN,
 funding: { pct: clampPct(c.funding && c.funding.pct), needed: ((c.funding && c.funding.needed) || "$60,000").toString().slice(0, 30) }
 };
}
function clampPct(n){ n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 64; }
/* Per-checklist-item notes: { [itemId]: "text" }. Keys and values are capped;
   empty values are dropped so the map only ever holds real notes. */
function normNotes(n){
 if(!n || typeof n !== "object") return {};
 const out = {};
 for(const k of Object.keys(n).slice(0, 1000)){
  const key = str(k, 60), val = str(n[k], 500).trim();
  if(key && val) out[key] = val;
 }
 return out;
}

export function normPrompter(p){
 p = p || {};
 const scripts = Array.isArray(p.scripts) ? p.scripts : [];
 return {
 // Tombstones: starter scripts a leader deleted stay deleted instead of
 // being re-merged on the next read.
 removed: Array.isArray(p.removed) ? p.removed.map(x => str(x, 40)).filter(Boolean).slice(0, 400) : [],
 scripts: scripts.map(sc => ({
 id: (sc.id || "").toString().slice(0, 40),
 event: (sc.event || "").toString().slice(0, 60),
 title: (sc.title || "").toString().slice(0, 80),
 due: (sc.due || "").toString().slice(0, 10),
 assignee: (sc.assignee || "").toString().slice(0, 30),
 body: (sc.body || "").toString().slice(0, 20000),
 done: sc.done && sc.done.initials
 ? { initials:(sc.done.initials||"").toString().slice(0,40), date:(sc.done.date||"").toString().slice(0,12) }
 : null
 })).slice(0, 200) };
}

/* Merge any starter script whose id is neither on the board nor tombstoned.
   Returns true when something was added (i.e. a write is warranted). */
function mergeStarterScripts(p){
 const have = new Set(p.scripts.map(x => x.id));
 const gone = new Set(p.removed);
 let added = false;
 for(const sc of STARTER_SCRIPTS){
  if(!sc || !sc.id || have.has(sc.id) || gone.has(sc.id)) continue;
  p.scripts.push(normPrompter({ scripts: [sc] }).scripts[0]);
  added = true;
 }
 return added;
}

/* ---- radios ---- */
function defaultRadios(){ const a = []; for(let i = 1; i <= 10; i++) a.push({ n:i, out:null, in:null }); return a; }
function normStamp(x){ if(!x || !x.by) return null; return { by:(x.by || "").toString().slice(0, 40), t:(x.t || "").toString().slice(0, 12) }; }
function normRadios(r){
 const src = (r && Array.isArray(r.list)) ? r.list : [];
 const out = defaultRadios();
 for(const it of src){
 const n = Number(it && it.n);
 if(n >= 1 && n <= 10) out[n-1] = { n, out: normStamp(it.out), in: normStamp(it.in) };
 }
 return { list: out };
}
const normCheckins = v => Array.isArray(v) ? v.map(normCheckin).slice(-2000) : [];
const normIO = v => ({ list: (v && Array.isArray(v.list)) ? v.list : [] });

/* ---- PIN brute-force protection ----
   Per-IP sliding window kept in a blob: 15 wrong PIN entries in 10 minutes
   blocks further PIN checks from that IP until the window slides past.
   Forgiving on purpose — event WiFi/CGNAT can put several phones behind one
   IP and morning-huddle typos are normal, so the threshold is generous,
   empty PINs are never counted, and a correct leader PIN clears the record. */
const PIN_MAX_FAILS = 15, PIN_WINDOW_MS = 10 * 60 * 1000;
function pinFailKey(req, context){
 let ip = (context && context.ip)
  || req.headers.get("x-nf-client-connection-ip")
  || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
  || "unknown";
 ip = ip.toString().replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 48) || "unknown";
 return "pinfail-" + ip;
}
async function pinFails(s, key){
 let rec = null;
 try { rec = await s.get(key, { type:"json" }); } catch(_) {}
 const cutoff = Date.now() - PIN_WINDOW_MS;
 return (rec && Array.isArray(rec.t) ? rec.t : []).filter(t => t > cutoff);
}
async function pinNoteFail(s, key){
 const t = await pinFails(s, key);
 t.push(Date.now());
 await s.setJSON(key, { t: t.slice(-PIN_MAX_FAILS * 2) }).catch(() => {});
}
const pinBlockedResp = () => json({ error:"too many wrong PIN attempts — wait 10 minutes and try again", rateLimited:true }, 429);

const LEADER_ACTIONS = new Set([
 "toggleCheck","setChecklistNote","addAnnouncement","ackCard","setEvent","setIOList","setDayPin",
 "setFunding","reset","promptSeed","promptAdd","promptEdit","promptDelete",
 "capturesList","captureMedia","captureDelete"
]);

function devKey(id){
 id = (id || "anon").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "anon";
 return "count-" + id;
}
function tallyKey(id){
 id = (id || "anon").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "anon";
 return "tally-" + id;
}
function tal2Key(id){
 id = (id || "anon").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "anon";
 return "tal2-" + id;
}
async function readEpoch(s){
 let e = null;
 try { e = await s.get("tallyEpoch", { type:"json" }); } catch(_) {}
 return (e && typeof e.e === "string") ? e.e : "";
}

/* ---------------- compare-and-swap ----------------
 Read a blob with its etag, let `mutate` produce the next value, then write
 only-if-the-etag-still-matches (or only-if-new when the blob is absent). On a
 conflict (someone else wrote first) we re-read and re-apply. `mutate` MUST be a
 pure function of the freshly-read value — that is what makes concurrent writers
 safe. Returning undefined from `mutate` means "no change, don't write".
 Between retries we sleep a jittered, growing backoff so a burst of writers on
 the same blob de-synchronizes instead of thundering in lockstep. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = attempt => sleep(Math.floor(Math.random() * 25) + attempt * 4);

async function compareAndSwap(s, key, normalize, mutate, fallback){
 for(let attempt = 0; attempt < 30; attempt++){
  if(attempt) await backoff(attempt);
  let res = null;
  try { res = await s.getWithMetadata(key, { type:"json" }); } catch(_) { res = null; }
  const exists = !!(res && res.data != null);
  let base = exists ? res.data : (typeof fallback === "function" ? await fallback() : (fallback ?? null));
  if(normalize) base = normalize(base);
  const next = mutate(base);
  if(next === undefined) return base; // caller signalled no-op
  const opts = exists ? { onlyIfMatch: res.etag } : { onlyIfNew: true };
  let w;
  try { w = await s.setJSON(key, next, opts); } catch(_) { w = { modified:false }; }
  if(w && w.modified) return next;
 }
 throw new Error("write conflict: " + key);
}
const legacyState = s => async () => (await s.get("state", { type:"json" })) || {};
const casCore = (s, mutate) => compareAndSwap(s, "core", normCore, mutate, legacyState(s));

async function readAll(s){
 const [core, checkins, io, prompter, radios] = await Promise.all([
 s.get("core", { type:"json" }),
 s.get("checkins", { type:"json" }),
 s.get("io", { type:"json" }),
 s.get("prompter", { type:"json" }),
 s.get("radios", { type:"json" })
 ]);
 return { core, checkins, io, prompter, radios };
}

async function migrateIfNeeded(s, parts){
 if(parts.core) return parts; // already on split layout
 const old = await s.get("state", { type:"json" });
 const core = normCore(old || {});
 const checkins = normCheckins((old && old.checkins) || []);
 const io = { list: (old && old.ioList) || [] };
 const prompter = normPrompter(old && old.prompter);
 await Promise.all([
 s.setJSON("core", core),
 s.setJSON("checkins", checkins),
 s.setJSON("io", io),
 s.setJSON("prompter", prompter),
 (old && old.count) ? s.setJSON(devKey("legacy"), old.count) : Promise.resolve()
 ]);
 // old "state" blob is left in place untouched as a safety net
 return { core, checkins, io, prompter, radios: parts.radios || null };
}

/* ---- head count aggregation ---- */
async function sumCounts(s){
 let total = 0;
 const { blobs } = await s.list({ prefix: "count-" });
 await Promise.all((blobs || []).map(async b => {
 const n = await s.get(b.key, { type:"json" });
 if(typeof n === "number") total += n;
 }));
 return Math.max(0, total);
}
async function sumTally(s){
 let total = 0; const by = {};
 const [t1, t2] = await Promise.all([ s.list({ prefix: "tally-" }), s.list({ prefix: "tal2-" }) ]);
 const blobs = [ ...((t1 && t1.blobs) || []), ...((t2 && t2.blobs) || []) ];
 await Promise.all(blobs.map(async b => {
 const tally = compactTally(await s.get(b.key, { type:"json" }));
 total += tally.total;
 for(const k of Object.keys(tally.by)) by[k] = (by[k] || 0) + tally.by[k];
 }));
 for(const k of Object.keys(by)) by[k] = Math.max(0, by[k]);
 return { total: Math.max(0, total), by };
}

/* Convert the old growing tap log to one compact per-device summary.
   Each device owns its own key, so 2-3 counters never overwrite each other. */
function compactTally(value){
 const out = { total:0, by:{} };
 if(Array.isArray(value)){
 for(const e of value){
 const d = Number(e && e.delta) || 0;
 const k = ((e && e.by) || "?").toString().slice(0, 40) || "?";
 out.total += d; out.by[k] = (out.by[k] || 0) + d;
 }
 }else if(value && typeof value === "object"){
 out.total = Number(value.total) || 0;
 const src = value.by && typeof value.by === "object" ? value.by : {};
 for(const k of Object.keys(src)) out.by[k] = Number(src[k]) || 0;
 }
 out.total = Math.max(0, out.total);
 for(const k of Object.keys(out.by)) out.by[k] = Math.max(0, out.by[k]);
 return out;
}

/* Authoritative rebuild of the head count from every shard (legacy + tally). */
async function rebuildAgg(s){
 const [cnt, tally] = await Promise.all([sumCounts(s), sumTally(s)]);
 return { total: Math.max(0, cnt + tally.total), by: tally.by };
}
/* Fast read: use the cached aggregate; rebuild + seed it if it is missing. */
async function readAgg(s){
 let agg = await s.get("count-agg", { type:"json" });
 if(!agg || typeof agg.total !== "number" || !agg.by || typeof agg.by !== "object"){
  agg = await rebuildAgg(s);
  await s.setJSON("count-agg", agg).catch(() => {});
 }
 return agg;
}
/* Apply an already-persisted shard delta to the cached aggregate under CAS.
   If it drifts or we can't win the race, we delete it so the next read rebuilds
   from the shards (which are the source of truth) — never wrong for long. */
async function bumpAgg(s, effTotal, effBy){
 for(let attempt = 0; attempt < 20; attempt++){
  if(attempt) await backoff(attempt);
  let res = null;
  try { res = await s.getWithMetadata("count-agg", { type:"json" }); } catch(_) { res = null; }
  if(!(res && res.data && typeof res.data.total === "number")){
   // No cache yet — seed it from the shards (which already include this tap).
   const fresh = await rebuildAgg(s);
   let w; try { w = await s.setJSON("count-agg", fresh, { onlyIfNew:true }); } catch(_) { w = { modified:false }; }
   if(w && w.modified) return;
   continue; // someone else seeded it; loop to apply our delta on top
  }
  const agg = { total: Math.max(0, (Number(res.data.total) || 0) + (effTotal || 0)), by: { ...res.data.by } };
  if(effBy) for(const k of Object.keys(effBy)) agg.by[k] = Math.max(0, (Number(agg.by[k]) || 0) + effBy[k]);
  let w; try { w = await s.setJSON("count-agg", agg, { onlyIfMatch: res.etag }); } catch(_) { w = { modified:false }; }
  if(w && w.modified) return;
 }
 await s.delete("count-agg").catch(() => {}); // give up cleanly → next read rebuilds
}

async function assemble(s){
 let parts = await readAll(s);
 parts = await migrateIfNeeded(s, parts);
 const core = normCore(parts.core);
 const [agg, tallyEpoch, capturesRaw] = await Promise.all([ readAgg(s), readEpoch(s), s.get("captures", { type:"json" }) ]);
 // Self-seeding script board: fill in any missing starter scripts (no-op
 // write when nothing is missing, so the usual GET stays read-only).
 const prompter = await compareAndSwap(s, "prompter", normPrompter,
  p => mergeStarterScripts(p) ? p : undefined, () => ({ scripts: [] }));
 return {
 checklist: core.checklist,
 notes: core.notes,
 announcements: core.announcements,
 checkins: normCheckins(parts.checkins),
 feedback: core.feedback,
 praises: core.praises,
 count: Math.max(0, agg.total),
 tallyBy: agg.by || {},
 tallyEpoch,
 radios: normRadios(parts.radios).list,
 event: core.event,
 ioList: (parts.io && Array.isArray(parts.io.list)) ? parts.io.list : [],
 dayPinSet: !!core.dayPin, // the PIN itself is never sent to clients
 funding: core.funding,
 prompter: prompter,
 // Quick Capture records hold seekers' contact info, so the shared payload
 // only carries the count; leaders pull the list with the capturesList action.
 captureCount: normCaptures(capturesRaw).length
 };
}

/* djb2-xor hash → weak ETag for cheap "did anything change?" polling. */
function hash(strv){
 let h = 5381;
 for(let i = 0; i < strv.length; i++) h = (((h << 5) + h) ^ strv.charCodeAt(i)) >>> 0;
 return h.toString(36);
}

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
 status, headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
});

export default async (req, context) => {
 const s = getStore(STORE, { consistency: "strong" });

 if(req.method === "GET"){
  const body = JSON.stringify(await assemble(s));
  const etag = 'W/"' + hash(body) + '"';
  // Unchanged since the client last saw it? Skip the payload AND the re-render.
  if(req.headers.get("if-none-match") === etag){
   return new Response(null, { status:304, headers:{ "ETag":etag, "Cache-Control":"no-store" } });
  }
  return new Response(body, { status:200, headers:{ "Content-Type":"application/json", "Cache-Control":"no-store", "ETag":etag } });
 }

 if(req.method === "POST"){
 let body = {};
 try { body = await req.json(); } catch(_) {}
 const action = body.action;
 const payload = body.payload || {};
 const pin = (body.pin || "").toString();

 /* ---- PIN rate limit: any non-empty PIN about to be checked counts ---- */
 const checksPin = action === "verifyLeaderPin" || action === "verifyDayPin" || LEADER_ACTIONS.has(action);
 const failKey = pinFailKey(req, context);
 if(pin && checksPin && (await pinFails(s, failKey)).length >= PIN_MAX_FAILS){
 return pinBlockedResp();
 }

 /* ---- PIN verification (no state change) ---- */
 if(action === "verifyLeaderPin"){
 if(pin === LEADER_PIN()){ s.delete(failKey).catch(() => {}); return json({ ok:true }); }
 if(pin) await pinNoteFail(s, failKey);
 return json({ error:"wrong pin" }, 403);
 }
 if(action === "verifyDayPin"){
 if(pin && pin === LEADER_PIN()){ s.delete(failKey).catch(() => {}); return json({ ok:true, leader:true }); }
 const core = normCore((await s.get("core", { type:"json" })) || (await s.get("state", { type:"json" })) || {});
 if(core.dayPin && pin === core.dayPin) return json({ ok:true, leader:false });
 if(pin) await pinNoteFail(s, failKey);
 return json({ error:"wrong pin" }, 403);
 }

 /* ---- privileged actions require the leader PIN, verified here ---- */
 if(LEADER_ACTIONS.has(action) && pin !== LEADER_PIN()){
 if(pin) await pinNoteFail(s, failKey);
 return json({ error:"leader pin required" }, 403);
 }

 /* ---- legacy counter: each device writes ONLY its own shard ---- */
 if(action === "bump"){
 const key = devKey(payload.dev);
 const cur = (await s.get(key, { type:"json" })) || 0;
 const before = (typeof cur === "number" ? cur : 0);
 const after = before + (Number(payload.delta) || 0);
 await s.setJSON(key, after);
 await bumpAgg(s, after - before, null);
 return json({ ok:true });
 }

 /* ---- v1.3.0 tally: per-phone summary {total, by}. A phone only writes its
    own shard (and the client serializes its own taps), so simultaneous
    counters can never erase each other. We then fold the *effective* delta
    (after clamping at 0) into the cached aggregate so GET stays O(1). ---- */
 /* ---- v1.6.0 absolute tally: the phone pushes its WHOLE per-device tally
    ("my total is N, split by name"), and the server stores it as-is in the
    phone's own tal2- shard. Idempotent by construction — a retry of a request
    that already landed changes nothing, and a dropped request just means the
    next push carries the missing taps. The delta vs. the previous shard value
    is folded into the cached aggregate so GET stays O(1). ---- */
 if(action === "tallySet"){
 const epoch = await readEpoch(s);
 if(((payload.epoch || "") + "") !== epoch){
  // The event was reset while this phone still held a pre-reset tally.
  // Tell it to clear instead of resurrecting old numbers.
  const agg = await readAgg(s);
  return json({ ok:false, epochMismatch:true, epoch, count: Math.max(0, agg.total), tallyBy: agg.by || {} });
 }
 const inc = compactTally({ total: payload.total, by: payload.by });
 const next = { total: Math.min(inc.total, 100000), by: {} };
 for(const k of Object.keys(inc.by).slice(0, 30)){
  const name = str(k, 40) || "?";
  next.by[name] = Math.min(inc.by[k], 100000);
 }
 let prev = { total:0, by:{} };
 await compareAndSwap(s, tal2Key(payload.dev), compactTally, cur => {
  prev = cur;
  return (JSON.stringify(cur) === JSON.stringify(next)) ? undefined : next;
 }, () => ({ total:0, by:{} }));
 const effBy = {};
 for(const k of new Set([ ...Object.keys(prev.by), ...Object.keys(next.by) ])){
  const d = (next.by[k] || 0) - (prev.by[k] || 0);
  if(d) effBy[k] = d;
 }
 const effTotal = next.total - prev.total;
 if(effTotal || Object.keys(effBy).length) await bumpAgg(s, effTotal, effBy);
 const agg = await readAgg(s);
 return json({ ok:true, count: Math.max(0, agg.total), tallyBy: agg.by || {} });
 }

 if(action === "tallyAdd"){
 const key = tallyKey(payload.dev);
 const tally = compactTally(await s.get(key, { type:"json" }));
 const by = (payload.by || "?").toString().slice(0, 40) || "?";
 const delta = Number(payload.delta) || 0;
 const beforeTotal = tally.total, beforeBy = tally.by[by] || 0;
 tally.total = Math.max(0, tally.total + delta);
 tally.by[by] = Math.max(0, (tally.by[by] || 0) + delta);
 await s.setJSON(key, tally);
 await bumpAgg(s, tally.total - beforeTotal, { [by]: tally.by[by] - beforeBy });
 return json({ ok:true });
 }

 /* ---- everything else touches exactly one blob, via compare-and-swap ---- */
 // Ensure the split blobs exist (first-run migration off the old single blob).
 await migrateIfNeeded(s, await readAll(s));

 switch(action){
 case "toggleCheck":
 await casCore(s, core => {
 const id = payload.id;
 if(id){
 if(core.checklist[id]) delete core.checklist[id];
 else core.checklist[id] = { by: str(payload.by, 40), t: str(payload.t, 12), dm: (payload.dm ?? null) };
 }
 return core;
 });
 break;
 case "setChecklistNote":
 await casCore(s, core => {
 const id = str(payload.id, 60);
 if(!id) return undefined;
 core.notes = core.notes || {};
 const t = str(payload.text, 500).trim();
 if(t) core.notes[id] = t; else delete core.notes[id];
 return core;
 });
 break;
 case "addCheckin":
 await compareAndSwap(s, "checkins", normCheckins, list => { list.push(normCheckin(payload)); return list.slice(-2000); }, () => []);
 break;
 case "addAnnouncement":
 await casCore(s, core => { core.announcements.unshift(normAnn(payload)); core.announcements = core.announcements.slice(0, 200); return core; });
 break;
 case "addPraise":
 await casCore(s, core => {
 const it = normPraiseItem(payload); it.hidden = false; it.ackBy = ""; it.ackT = ""; it.comments = [];
 core.praises.unshift(it); core.praises = core.praises.slice(0, 500); return core;
 });
 break;
 case "addFeedback":
 await casCore(s, core => {
 const it = normIssue(payload); it.hidden = false; it.ackBy = ""; it.ackT = ""; it.comments = [];
 core.feedback.unshift(it); core.feedback = core.feedback.slice(0, 500); return core;
 });
 break;
 case "addComment":
 await casCore(s, core => {
 const arr = payload.kind === "praise" ? core.praises : (payload.kind === "ann" ? core.announcements : core.feedback);
 const it = arr.find(x => x.id === payload.id);
 if(!it) return undefined; // nothing to update — skip the write
 it.comments = Array.isArray(it.comments) ? it.comments : [];
 it.comments.push({ name: str(payload.name || "Volunteer", 40), text: str(payload.text, 500), t: str(payload.t, 12) });
 it.comments = it.comments.slice(-100);
 return core;
 });
 break;
 case "radioToggle":
 await compareAndSwap(s, "radios", normRadios, rad => {
 const n = Number(payload.n);
 if(!(n >= 1 && n <= 10)) return undefined;
 const r = rad.list[n-1];
 const stamp = { by:(payload.by || "?").toString().slice(0, 40), t:(payload.t || "").toString().slice(0, 12) };
 if(r.out && !r.in){ r.in = stamp; } // returning it
 else { r.out = stamp; r.in = null; } // checking it out
 return rad;
 }, () => ({ list: defaultRadios() }));
 break;
 case "setEvent":
 await casCore(s, core => { core.event = { name: payload.name || "", date: payload.date || "" }; return core; });
 break;
 case "setIOList":
 if(!Array.isArray(payload.list)) break;
 await compareAndSwap(s, "io", normIO, io => { io.list = payload.list; return io; }, () => ({ list: [] }));
 break;
 case "setDayPin":
 await casCore(s, core => { core.dayPin = (payload.pin || "").toString().trim().slice(0, 10); return core; });
 break;
 case "setFunding":
 await casCore(s, core => { core.funding = { pct: clampPct(payload.pct), needed: (payload.needed || "").toString().slice(0, 30) || core.funding.needed }; return core; });
 break;
 case "ackCard":
 await casCore(s, core => {
 const arr = payload.kind === "praise" ? core.praises : core.feedback;
 const it = arr.find(x => x.id === payload.id);
 if(!it) return undefined;
 const hide = !it.hidden;
 it.hidden = hide;
 it.ackBy = hide ? str(payload.by, 40) : "";
 it.ackT = hide ? str(payload.t, 12) : "";
 return core;
 });
 break;
 case "reset": {
 /* ISSUES AND PRAISES SURVIVE THE RESET, per leadership — the praise wall is
    a lasting testimony record, not a day-scoped list (this also fixes reports
    of praise "disappearing" / being un-postable after an end-of-day reset).
    Clears checklists, check-ins, counts (legacy + tally), announcements &
    radios. Keeps event info, Day PIN, funding, I/O roster (progress cleared),
    the Recording Studio scripts, issues and praises. Quick Captures also
    SURVIVE the reset — they are seekers' contact info headed for the CRM,
    never day-scoped throwaway data (leaders delete them individually once
    they're in Planning Center). */
 await casCore(s, core => ({ ...EMPTY_CORE, event: core.event, dayPin: core.dayPin, funding: core.funding, feedback: core.feedback, praises: core.praises }));
 await compareAndSwap(s, "io", normIO, io => { io.list = ioListClearProgress(io.list); return io; }, () => ({ list: [] }));
 const [c1, c2, c3] = await Promise.all([ s.list({ prefix: "count-" }), s.list({ prefix: "tally-" }), s.list({ prefix: "tal2-" }) ]);
 const doomed = [ ...((c1 && c1.blobs) || []), ...((c2 && c2.blobs) || []), ...((c3 && c3.blobs) || []) ]
  .filter(b => b.key !== "count-agg"); // rewritten below, not deleted (racy otherwise)
 await Promise.all([
 s.setJSON("checkins", []),
 s.setJSON("radios", { list: defaultRadios() }),
 s.setJSON("count-agg", { total:0, by:{} }),
 s.setJSON("tallyEpoch", { e: uid() }), // stale phones clear instead of re-pushing old tallies
 ...doomed.map(b => s.delete(b.key))
 ]);
 break;
 }
 /* ---- Recording Studio ---- */
 case "promptSeed":
 if(Array.isArray(payload.scripts))
 await compareAndSwap(s, "prompter", normPrompter, p => p.scripts.length ? undefined : normPrompter({ scripts: payload.scripts }), () => ({ scripts: [] }));
 break;
 case "promptAdd":
 if(payload.script && payload.script.id)
 await compareAndSwap(s, "prompter", normPrompter, p => { p.scripts.push(normPrompter({ scripts:[payload.script] }).scripts[0]); return p; }, () => ({ scripts: [] }));
 break;
 case "promptEdit":
 await compareAndSwap(s, "prompter", normPrompter, p => {
 const i = p.scripts.findIndex(x => x.id === payload.id);
 if(i < 0) return undefined;
 p.scripts[i] = normPrompter({ scripts:[{ ...p.scripts[i], ...(payload.patch || {}), id: payload.id }] }).scripts[0];
 return p;
 }, () => ({ scripts: [] }));
 break;
 case "promptDelete":
 await compareAndSwap(s, "prompter", normPrompter, p => {
 const id = str(payload.id, 40);
 if(!id) return undefined;
 p.scripts = p.scripts.filter(x => x.id !== id);
 if(!p.removed.includes(id)) p.removed.push(id); // tombstone: don't re-seed it
 return p;
 }, () => ({ scripts: [] }));
 break;
 case "promptDone":
 await compareAndSwap(s, "prompter", normPrompter, p => {
 const it = p.scripts.find(x => x.id === payload.id);
 if(!it) return undefined;
 it.done = { initials:(payload.initials||"").toString().slice(0,40), date:(payload.date||"").toString().slice(0,12) };
 return p;
 }, () => ({ scripts: [] }));
 break;
 case "promptUndone":
 await compareAndSwap(s, "prompter", normPrompter, p => {
 const it = p.scripts.find(x => x.id === payload.id);
 if(!it) return undefined;
 it.done = null;
 return p;
 }, () => ({ scripts: [] }));
 break;
 /* ---- Ambassador Quick Capture ---- */
 case "captureAdd": {
 // Open to everyone behind the Day PIN (like check-ins) — capture must be
 // frictionless on the street. Media lands in its own blob first so a
 // record never points at media that failed to store.
 const rec = normCapture(payload);
 const media = payload.media || null;
 if(media && typeof media.dataUrl === "string" && media.dataUrl.startsWith("data:") && media.dataUrl.length <= CAPTURE_MEDIA_MAX){
 rec.hasMedia = true;
 rec.mediaKind = media.kind === "photo" ? "photo" : "audio";
 await s.set(capMediaKey(rec.id), media.dataUrl);
 } else { rec.hasMedia = false; rec.mediaKind = ""; }
 await compareAndSwap(s, "captures", normCaptures, list => {
 if(list.some(c => c.id === rec.id)) return undefined; // idempotent retry
 list.push(rec);
 return list.slice(-1000);
 }, () => []);
 break;
 }
 case "capturesList":
 return json({ captures: normCaptures(await s.get("captures", { type:"json" })) });
 case "captureMedia": {
 const dataUrl = await s.get(capMediaKey(payload.id));
 return json({ id: str(payload.id, 40), dataUrl: (typeof dataUrl === "string" && dataUrl.startsWith("data:")) ? dataUrl : "" });
 }
 case "captureDelete":
 await compareAndSwap(s, "captures", normCaptures, list => {
 const id = str(payload.id, 40);
 if(!list.some(c => c.id === id)) return undefined;
 return list.filter(c => c.id !== id);
 }, () => []);
 await s.delete(capMediaKey(payload.id)).catch(() => {});
 break;
 default: return json({ error:"unknown action" }, 400);
 }
 /* The browser already applied the change optimistically. Do not rebuild and
    resend the whole app after every write; the sync loop reconciles. */
 return json({ ok:true });
 }

 return json({ error:"method not allowed" }, 405);
};

export const config = { path: "/.netlify/functions/data" };
