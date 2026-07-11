import { getStore } from "@netlify/blobs";

const STORE = "k2c-ambassador";
const DEFAULT_DAY_PIN = "0711";
// Leader PIN is verified SERVER-SIDE. Rotate it by setting a LEADER_PIN
// environment variable in Netlify (Site settings → Environment variables),
// then redeploying — no code change needed.
const LEADER_PIN = () => process.env.LEADER_PIN || "2026";

/* ---------------- storage layout ----------------
 v19 (app v1.3.0) — split-by-domain blobs so concurrent writes never clobber:
 core     — checklist, announcements, feedback (issues + comments), praises,
            event, dayPin, funding
 checkins — check-in list
 io       — Tech I/O roster + patch progress
 prompter — Recording Studio scripts
 radios   — 10-radio checkout board (initials + times)
 count-  — LEGACY numeric counter shard per phone (still summed, still works)
 tally-  — NEW per-phone append-only tally log [{by,delta,t}] — the total AND
            a per-initials breakdown are computed by summing every entry, so
            multiple counters can tap at once and nothing is ever lost.
 Old single-blob data migrates automatically on first read. */

const EMPTY_CORE = { checklist:{}, announcements:[], feedback:[], praises:[], event:{name:"",date:""}, dayPin:DEFAULT_DAY_PIN, funding:{pct:64, needed:"$60,000"} };

function ioListClearProgress(list){
 if(!Array.isArray(list) || !list.length) return list;
 return list.map(p => ({ ...p, rows: (p.rows || []).map(r => ({ ...r, done:false, by:"", t:"" })) }));
}

export function normCore(c){
 c = c || {};
 return {
 checklist: c.checklist || {},
 announcements: c.announcements || [],
 feedback: c.feedback || [],
 praises: c.praises || [],
 event: c.event || { name:"", date:"" },
 // One-time migration: retire the old 0627 Day PIN in favor of 0711.
 dayPin: (typeof c.dayPin === "string" && c.dayPin !== "0627") ? c.dayPin : DEFAULT_DAY_PIN,
 funding: { pct: clampPct(c.funding && c.funding.pct), needed: ((c.funding && c.funding.needed) || "$60,000").toString().slice(0, 30) }
 };
}
function clampPct(n){ n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 64; }

export function normPrompter(p){
 p = p || {};
 const scripts = Array.isArray(p.scripts) ? p.scripts : [];
 return { scripts: scripts.map(sc => ({
 id: (sc.id || "").toString().slice(0, 40),
 event: (sc.event || "").toString().slice(0, 60),
 title: (sc.title || "").toString().slice(0, 80),
 due: (sc.due || "").toString().slice(0, 10),
 assignee: (sc.assignee || "").toString().slice(0, 30),
 body: (sc.body || "").toString().slice(0, 20000),
 done: sc.done && sc.done.initials
 ? { initials:(sc.done.initials||"").toString().slice(0,4), date:(sc.done.date||"").toString().slice(0,12) }
 : null
 })).slice(0, 200) };
}

/* ---- radios ---- */
function defaultRadios(){ const a = []; for(let i = 1; i <= 10; i++) a.push({ n:i, out:null, in:null }); return a; }
function normStamp(x){ if(!x || !x.by) return null; return { by:(x.by || "").toString().toUpperCase().slice(0, 4), t:(x.t || "").toString().slice(0, 12) }; }
function normRadios(r){
 const src = (r && Array.isArray(r.list)) ? r.list : [];
 const out = defaultRadios();
 for(const it of src){
 const n = Number(it && it.n);
 if(n >= 1 && n <= 10) out[n-1] = { n, out: normStamp(it.out), in: normStamp(it.in) };
 }
 return { list: out };
}

const LEADER_ACTIONS = new Set([
 "toggleCheck","addAnnouncement","ackCard","setEvent","setIOList","setDayPin",
 "setFunding","reset","promptSeed","promptAdd","promptEdit","promptDelete"
]);

function devKey(id){
 id = (id || "anon").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "anon";
 return "count-" + id;
}
function tallyKey(id){
 id = (id || "anon").toString().replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "anon";
 return "tally-" + id;
}

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
 const checkins = (old && old.checkins) || [];
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
 const { blobs } = await s.list({ prefix: "tally-" });
 await Promise.all((blobs || []).map(async b => {
 const arr = await s.get(b.key, { type:"json" });
 if(Array.isArray(arr)) for(const e of arr){
 const d = Number(e && e.delta) || 0;
 const k = ((e && e.by) || "?").toString().toUpperCase().slice(0, 4) || "?";
 total += d; by[k] = (by[k] || 0) + d;
 }
 }));
 for(const k of Object.keys(by)) by[k] = Math.max(0, by[k]);
 return { total: Math.max(0, total), by };
}

async function assemble(s){
 let parts = await readAll(s);
 parts = await migrateIfNeeded(s, parts);
 const core = normCore(parts.core);
 const [cnt, tally] = await Promise.all([sumCounts(s), sumTally(s)]);
 return {
 checklist: core.checklist,
 announcements: core.announcements,
 checkins: Array.isArray(parts.checkins) ? parts.checkins : [],
 feedback: core.feedback,
 praises: core.praises,
 count: Math.max(0, cnt + tally.total),
 tallyBy: tally.by,
 radios: normRadios(parts.radios).list,
 event: core.event,
 ioList: (parts.io && Array.isArray(parts.io.list)) ? parts.io.list : [],
 dayPinSet: !!core.dayPin, // the PIN itself is never sent to clients
 funding: core.funding,
 prompter: normPrompter(parts.prompter)
 };
}

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
 status, headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
});

export default async (req) => {
 const s = getStore(STORE, { consistency: "strong" });

 if(req.method === "GET") return json(await assemble(s));

 if(req.method === "POST"){
 let body = {};
 try { body = await req.json(); } catch(_) {}
 const action = body.action;
 const payload = body.payload || {};
 const pin = (body.pin || "").toString();

 /* ---- PIN verification (no state change) ---- */
 if(action === "verifyLeaderPin"){
 return pin === LEADER_PIN() ? json({ ok:true }) : json({ error:"wrong pin" }, 403);
 }
 if(action === "verifyDayPin"){
 if(pin && pin === LEADER_PIN()) return json({ ok:true, leader:true });
 const core = normCore((await s.get("core", { type:"json" })) || (await s.get("state", { type:"json" })) || {});
 if(core.dayPin && pin === core.dayPin) return json({ ok:true, leader:false });
 return json({ error:"wrong pin" }, 403);
 }

 /* ---- privileged actions require the leader PIN, verified here ---- */
 if(LEADER_ACTIONS.has(action) && pin !== LEADER_PIN()){
 return json({ error:"leader pin required" }, 403);
 }

 /* ---- legacy counter: each device writes ONLY its own shard ---- */
 if(action === "bump"){
 const key = devKey(payload.dev);
 const cur = (await s.get(key, { type:"json" })) || 0;
 await s.setJSON(key, (typeof cur === "number" ? cur : 0) + (Number(payload.delta) || 0));
 return json(await assemble(s));
 }

 /* ---- v1.3.0 tally: append-only per-phone log with initials ----
 Every tap is {by, delta, t}. Undo = a negative entry. Nothing is
 overwritten, so simultaneous counters can never erase each other,
 and the leader dashboard can break the total down per initials. */
 if(action === "tallyAdd"){
 const key = tallyKey(payload.dev);
 const cur = await s.get(key, { type:"json" });
 const arr = Array.isArray(cur) ? cur : [];
 arr.push({
 by: (payload.by || "?").toString().toUpperCase().slice(0, 4) || "?",
 delta: Number(payload.delta) || 0,
 t: (payload.t || "").toString().slice(0, 12)
 });
 await s.setJSON(key, arr.slice(-4000));
 return json(await assemble(s));
 }

 /* ---- everything else touches exactly one blob ---- */
 let parts = await readAll(s);
 parts = await migrateIfNeeded(s, parts);
 const core = normCore(parts.core);
 const checkins = Array.isArray(parts.checkins) ? parts.checkins : [];
 const io = (parts.io && Array.isArray(parts.io.list)) ? parts.io : { list: [] };
 const prompter = normPrompter(parts.prompter);

 switch(action){
 case "toggleCheck": {
 const id = payload.id;
 if(id){
 if(core.checklist[id]) delete core.checklist[id];
 else core.checklist[id] = { by: payload.by || "", t: payload.t || "", dm: (payload.dm ?? null) };
 }
 await s.setJSON("core", core); break;
 }
 case "addCheckin": checkins.push(payload); await s.setJSON("checkins", checkins); break;
 case "addAnnouncement": core.announcements.unshift(payload); await s.setJSON("core", core); break;
 case "addPraise": core.praises.unshift(payload); await s.setJSON("core", core); break;
 case "addFeedback": core.feedback.unshift(payload); await s.setJSON("core", core); break;
 case "addComment": {
 const arr = payload.kind === "praise" ? core.praises : (payload.kind === "ann" ? core.announcements : core.feedback);
 const it = arr.find(x => x.id === payload.id);
 if(it){
 it.comments = Array.isArray(it.comments) ? it.comments : [];
 it.comments.push({
 name: (payload.name || "Volunteer").toString().slice(0, 40),
 text: (payload.text || "").toString().slice(0, 500),
 t: (payload.t || "").toString().slice(0, 12)
 });
 it.comments = it.comments.slice(-100);
 }
 await s.setJSON("core", core); break;
 }
 case "radioToggle": {
 const rad = normRadios(parts.radios);
 const n = Number(payload.n);
 if(n >= 1 && n <= 10){
 const r = rad.list[n-1];
 const stamp = { by:(payload.by || "?").toString().toUpperCase().slice(0, 4), t:(payload.t || "").toString().slice(0, 12) };
 if(r.out && !r.in){ r.in = stamp; } // returning it
 else { r.out = stamp; r.in = null; } // checking it out
 await s.setJSON("radios", rad);
 }
 break;
 }
 case "setEvent": core.event = { name: payload.name || "", date: payload.date || "" }; await s.setJSON("core", core); break;
 case "setIOList": if(Array.isArray(payload.list)){ io.list = payload.list; await s.setJSON("io", io); } break;
 case "setDayPin": core.dayPin = (payload.pin || "").toString().trim().slice(0, 10); await s.setJSON("core", core); break;
 case "setFunding": core.funding = { pct: clampPct(payload.pct), needed: (payload.needed || "").toString().slice(0, 30) || core.funding.needed }; await s.setJSON("core", core); break;
 case "ackCard": {
 const arr = payload.kind === "praise" ? core.praises : core.feedback;
 const it = arr.find(x => x.id === payload.id);
 if(it){
 const hide = !it.hidden;
 it.hidden = hide;
 it.ackBy = hide ? (payload.by || "") : "";
 it.ackT = hide ? (payload.t || "") : "";
 }
 await s.setJSON("core", core); break;
 }
 case "reset": {
 /* v1.3.0 — ISSUES SURVIVE THE RESET (open + acknowledged), per leadership.
 Clears checklists, check-ins, counts (legacy + tally), praises,
 announcements & radios. Keeps event info, Day PIN, funding, I/O roster
 (progress cleared) and the Recording Studio scripts. */
 const fresh = { ...EMPTY_CORE, event: core.event, dayPin: core.dayPin, funding: core.funding, feedback: core.feedback };
 io.list = ioListClearProgress(io.list);
 const [c1, c2] = await Promise.all([ s.list({ prefix: "count-" }), s.list({ prefix: "tally-" }) ]);
 const doomed = [ ...((c1 && c1.blobs) || []), ...((c2 && c2.blobs) || []) ];
 await Promise.all([
 s.setJSON("core", fresh),
 s.setJSON("checkins", []),
 s.setJSON("io", io),
 s.setJSON("radios", { list: defaultRadios() }),
 ...doomed.map(b => s.delete(b.key))
 ]);
 break;
 }
 /* ---- Recording Studio ---- */
 case "promptSeed":
 if(!prompter.scripts.length && Array.isArray(payload.scripts)){
 await s.setJSON("prompter", normPrompter({ scripts: payload.scripts }));
 }
 break;
 case "promptAdd":
 if(payload.script && payload.script.id){
 prompter.scripts.push(normPrompter({ scripts:[payload.script] }).scripts[0]);
 await s.setJSON("prompter", prompter);
 }
 break;
 case "promptEdit": {
 const i = prompter.scripts.findIndex(x => x.id === payload.id);
 if(i >= 0){
 const merged = { ...prompter.scripts[i], ...(payload.patch || {}), id: payload.id };
 prompter.scripts[i] = normPrompter({ scripts:[merged] }).scripts[0];
 await s.setJSON("prompter", prompter);
 }
 break;
 }
 case "promptDelete":
 prompter.scripts = prompter.scripts.filter(x => x.id !== payload.id);
 await s.setJSON("prompter", prompter);
 break;
 case "promptDone": {
 const it = prompter.scripts.find(x => x.id === payload.id);
 if(it){
 it.done = { initials:(payload.initials||"").toString().toUpperCase().slice(0,4), date:(payload.date||"").toString().slice(0,12) };
 await s.setJSON("prompter", prompter);
 }
 break;
 }
 case "promptUndone": {
 const it = prompter.scripts.find(x => x.id === payload.id);
 if(it){ it.done = null; await s.setJSON("prompter", prompter); }
 break;
 }
 default: return json({ error:"unknown action" }, 400);
 }
 return json(await assemble(s));
 }

 return json({ error:"method not allowed" }, 405);
};

export const config = { path: "/.netlify/functions/data" };
