import { getStore } from "@netlify/blobs";

const STORE = "k2c-ambassador";
const KEY = "state";
const DEFAULT_DAY_PIN = "0627";
const EMPTY = { checklist:{}, announcements:[], checkins:[], feedback:[], praises:[], count:0, event:{name:"",date:""}, ioList:[], dayPin:DEFAULT_DAY_PIN };

function normalize(s){
  s = s || {};
  return {
    checklist:     s.checklist     || {},
    announcements: s.announcements || [],
    checkins:      s.checkins      || [],
    feedback:      s.feedback      || [],
    praises:       s.praises       || [],
    count:         s.count         || 0,
    event:         s.event         || { name:"", date:"" },
    ioList:        Array.isArray(s.ioList) ? s.ioList : [],
    dayPin:        typeof s.dayPin === "string" ? s.dayPin : DEFAULT_DAY_PIN
  };
}

function apply(state, action, payload){
  payload = payload || {};
  switch(action){
    case "toggleCheck": {
      const id = payload.id;
      if(id){
        if(state.checklist[id]) delete state.checklist[id];
        else state.checklist[id] = { by: payload.by || "", t: payload.t || "", dm: (payload.dm ?? null) };
      }
      break;
    }
    case "addCheckin":      state.checkins.push(payload); break;
    case "addAnnouncement": state.announcements.unshift(payload); break;
    case "addPraise":       state.praises.unshift(payload); break;
    case "addFeedback":     state.feedback.unshift(payload); break;
    case "bump":            state.count = Math.max(0, (state.count||0) + (payload.delta||0)); break;
    case "setEvent":        state.event = { name: payload.name || "", date: payload.date || "" }; break;
    case "setIOList":       if(Array.isArray(payload.list)) state.ioList = payload.list; break;
    case "setDayPin":       state.dayPin = (payload.pin || "").toString().trim(); break;
    case "ackCard": {
      const arr = payload.kind === "praise" ? state.praises : state.feedback;
      const it = arr.find(x => x.id === payload.id);
      if(it){
        const hide = !it.hidden;
        it.hidden = hide;
        it.ackBy  = hide ? (payload.by || "") : "";
        it.ackT   = hide ? (payload.t  || "") : "";
      }
      break;
    }
    case "reset":           state = { ...EMPTY, event: state.event, dayPin: state.dayPin }; break;
  }
  return state;
}

const json = (obj, status=200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
});

export default async (req) => {
  const store = getStore(STORE, { consistency: "strong" });

  if(req.method === "GET"){
    const cur = await store.get(KEY, { type:"json" });
    return json(normalize(cur || EMPTY));
  }

  if(req.method === "POST"){
    let body = {};
    try { body = await req.json(); } catch(_) {}
    const cur  = normalize(await store.get(KEY, { type:"json" }) || EMPTY);
    const next = apply(cur, body.action, body.payload);
    await store.setJSON(KEY, next);
    return json(next);
  }

  return json({ error:"method not allowed" }, 405);
};

export const config = { path: "/.netlify/functions/data" };
