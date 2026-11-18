// Gemeinsamer Code fuer Dashboard (index.html) und Handy-Liste (liste.html).
//
// Einkaufsliste: liegt als geheimer Gist ("einkaufsliste.json") im GitHub-Konto.
// Der Zugangsschluessel (Token, nur Recht "gist") wird pro Geraet einmal
// eingegeben und bleibt im localStorage dieses Geraets -- nie im Repo.
// Beide Geraete finden denselben Gist ueber den Dateinamen.

const LIST_FILE = "einkaufsliste.json";
const LIST_DESC = "Kuechen-Dashboard: Einkaufsliste";
const LS_TOKEN = "dash_gh_token";
const LS_GIST = "dash_gist_id";
const LS_CACHE = "dash_list_cache";

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

const Liste = {
  token() { return lsGet(LS_TOKEN); },
  cached() {
    try { return JSON.parse(lsGet(LS_CACHE)) || { items: [] }; } catch { return { items: [] }; }
  },

  async api(path, opts = {}) {
    const r = await fetch("https://api.github.com" + path, {
      ...opts,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + this.token(),
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (r.status === 401) throw new Error("Schlüssel ungültig oder abgelaufen");
    if (!r.ok) throw new Error("GitHub antwortet " + r.status);
    return r.status === 204 ? null : r.json();
  },

  // Gist suchen oder anlegen. Ergebnis wird gemerkt.
  async gistId() {
    let id = lsGet(LS_GIST);
    if (id) return id;
    for (let page = 1; page <= 5; page++) {
      const gists = await this.api(`/gists?per_page=100&page=${page}`);
      const hit = gists.find(g => g.files && g.files[LIST_FILE]);
      if (hit) { lsSet(LS_GIST, hit.id); return hit.id; }
      if (gists.length < 100) break;
    }
    const g = await this.api("/gists", {
      method: "POST",
      body: JSON.stringify({
        description: LIST_DESC, public: false,
        files: { [LIST_FILE]: { content: JSON.stringify({ items: [] }, null, 1) } },
      }),
    });
    lsSet(LS_GIST, g.id);
    return g.id;
  },

  async load() {
    const id = await this.gistId();
    const g = await this.api("/gists/" + id);
    let data;
    try { data = JSON.parse(g.files[LIST_FILE].content); } catch { data = null; }
    if (!data || !Array.isArray(data.items)) data = { items: [] };
    if (g.comments > 0) data = await this.ingestInbox(id, data);
    lsSet(LS_CACHE, JSON.stringify(data));
    return data;
  },

  // Siri-Eingang: Der Kurzbefehl legt nur einen Kommentar am Gist an (eine einzige
  // Anfrage, kein JSON-Basteln in Kurzbefehle). Das naechste Geraet, das die Liste
  // laedt, uebernimmt die Kommentare als Eintraege und loescht sie danach.
  async ingestInbox(id, data) {
    if (this._ingesting) return data;
    this._ingesting = true;
    try {
      const cs = await this.api(`/gists/${id}/comments?per_page=100`);
      if (!cs.length) return data;
      const parts = cs.flatMap(c => this.split(c.body || ""));
      if (parts.length) {
        this.applyAdd(data, parts);
        await this.api("/gists/" + id, {
          method: "PATCH",
          body: JSON.stringify({ files: { [LIST_FILE]: { content: JSON.stringify(data, null, 1) } } }),
        });
      }
      for (const c of cs) {
        try { await this.api(`/gists/${id}/comments/${c.id}`, { method: "DELETE" }); } catch {}
      }
      return data;
    } catch { return data; }
    finally { this._ingesting = false; }
  },

  // Gist-ID fuer die Siri-Einrichtung
  async inboxUrl() { return `https://api.github.com/gists/${await this.gistId()}/comments`; },

  // Immer frisch lesen, Aenderung anwenden, zurueckschreiben -- so ueberschreibt
  // ein Geraet nicht, was das andere gerade eingetragen hat.
  async change(fn) {
    const data = await this.load();
    fn(data);
    await this.api("/gists/" + await this.gistId(), {
      method: "PATCH",
      body: JSON.stringify({ files: { [LIST_FILE]: { content: JSON.stringify(data, null, 1) } } }),
    });
    lsSet(LS_CACHE, JSON.stringify(data));
    return data;
  },

  // "Milch, Eier und Brot" -> drei Eintraege
  split(text) {
    return String(text).split(/\s*[,;\n]\s*|\s+und\s+|\s+&\s+/i)
      .map(s => s.trim().replace(/[.!?]+$/, "").trim()).filter(Boolean)
      .map(s => s.charAt(0).toUpperCase() + s.slice(1));
  },

  // Autokorrektur fuer Diktat- und Tippfehler: unbekanntes Wort -> sehr aehnliches
  // bekanntes Wort. Vergleich auf "Lautform" (Umlaute, y, -er/-a), gleicher
  // Anfangsbuchstabe Pflicht; bis 4 Laute keine, bis 6 eine, darueber zwei Abweichungen.
  correct(t, d) {
    const key = t.toLowerCase();
    const known = new Map();
    for (const f of Object.values(d.freq || {})) known.set(f.text.toLowerCase(), { text: f.text, n: f.n || 0 });
    for (const s of STARTER) if (!known.has(s.toLowerCase())) known.set(s.toLowerCase(), { text: s, n: 0 });
    for (const i of d.items) if (!known.has(i.text.toLowerCase())) known.set(i.text.toLowerCase(), { text: i.text, n: 0 });
    if (known.has(key)) return known.get(key).text;
    const a = sound(t);
    if (a.length < 3) return t;
    let best = null;
    for (const k of known.values()) {
      const b = sound(k.text);
      if (b[0] !== a[0]) continue;
      const L = Math.min(a.length, b.length), dist = lev(a, b);
      const max = L <= 4 ? 0 : L <= 6 ? 1 : 2;   // kurze Woerter nur bei gleicher Lautform
      if (dist > max) continue;
      if (!best || dist < best.dist || (dist === best.dist && k.n > best.n)) best = { ...k, dist };
    }
    return best ? best.text : t;
  },

  applyAdd(d, parts) {
    d.freq = d.freq || {};
    parts = parts.map(t => this.correct(t, d));
    for (const t of parts) {
      const key = t.toLowerCase();
      const f = d.freq[key] || (d.freq[key] = { text: t, n: 0 });
      f.n += 1;
      // Kaufrhythmus: hoechstens ein Eintrag pro Tag, die letzten 10 Tage merken
      const nowIso = new Date().toISOString();
      f.hist = f.hist || (f.last ? [f.last] : []);
      if (!f.hist.length || f.hist[f.hist.length - 1].slice(0, 10) !== nowIso.slice(0, 10)) f.hist.push(nowIso);
      f.hist = f.hist.slice(-10);
      f.last = nowIso;
      const same = d.items.find(i => i.text.toLowerCase() === key);
      if (same) { same.done = false; continue; }      // schon drauf -> wieder offen
      d.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                     text: f.text, done: false, added: new Date().toISOString() });
    }
  },
  add(text) {
    const parts = this.split(text);
    if (!parts.length) return Promise.resolve(this.cached());
    return this.change(d => this.applyAdd(d, parts));
  },

  // Vorschlaege: oft gekaufte Artikel, die gerade nicht offen auf der Liste stehen.
  // Bis die Liste genug gelernt hat, fuellen Grundnahrungsmittel auf.
  // Faellige Artikel (Kaufrhythmus erreicht) stehen vorne, Rueckgabe [{text, due}].
  suggestions(data, max = 14) {
    const open = new Set(data.items.filter(i => !i.done).map(i => i.text.toLowerCase()));
    const learned = Object.values(data.freq || {}).map(f => ({ ...f, due: isDue(f) }))
      .sort((a, b) => b.due - a.due || b.n - a.n || String(b.last).localeCompare(String(a.last)));
    const out = [], seen = new Set();
    for (const f of [...learned, ...STARTER.map(text => ({ text }))]) {
      if (!f.text) continue;
      const k = f.text.toLowerCase();
      if (seen.has(k) || open.has(k) || (data.hidden || []).includes(k)) continue;
      seen.add(k); out.push({ text: f.text, due: !!f.due });
      if (out.length >= max) break;
    }
    return out;
  },
  hide(text) {
    return this.change(d => {
      const k = text.toLowerCase();
      d.hidden = [...new Set([...(d.hidden || []), k])];
      if (d.freq) delete d.freq[k];
    });
  },
  addEvent(name, date, yearly, time) {
    return this.change(d => {
      d.events = d.events || [];
      const e = { id: Date.now().toString(36), name: name.trim(), date, yearly: !!yearly };
      if (time) e.time = time;
      d.events.push(e);
    });
  },
  removeEvent(id) { return this.change(d => { d.events = (d.events || []).filter(e => e.id !== id); }); },
  toggle(id) { return this.change(d => { const i = d.items.find(x => x.id === id); if (i) i.done = !i.done; }); },
  remove(id) { return this.change(d => { d.items = d.items.filter(x => x.id !== id); }); },
  clearDone() { return this.change(d => { d.items = d.items.filter(x => !x.done); }); },

  async setup(token) {
    lsSet(LS_TOKEN, token.trim());
    lsSet(LS_GIST, null);
    try { return await this.load(); }
    catch (e) { lsSet(LS_TOKEN, null); throw e; }
  },
  logout() { lsSet(LS_TOKEN, null); lsSet(LS_GIST, null); lsSet(LS_CACHE, null); },
};

const STARTER = ["Milch", "Eier", "Brot", "Butter", "Käse", "Skyr", "Joghurt", "Hähnchenbrust",
                 "Bananen", "Äpfel", "Tomaten", "Gurke", "Zwiebeln", "Kaffee", "Bier", "Toilettenpapier"];

// "Lautform" fuer die Autokorrektur: Bier ~ Bia, Skyr ~ Skür, Hähnchen ~ Hänchen
function sound(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss").replace(/y/g, "u").replace(/er\b/g, "a").replace(/ie/g, "i")
    .replace(/h(?![aeiou])/g, "").replace(/(.)\1+/g, "$1").replace(/[^a-z]/g, "");
}
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// Sofort in der Anzeige ergaenzen (vor der Antwort von GitHub)
function optimisticAdd(data, text) {
  for (const t of Liste.split(text)) {
    const same = data.items.find(i => i.text.toLowerCase() === t.toLowerCase());
    if (same) same.done = false;
    else data.items.push({ id: "tmp" + Date.now() + Math.random(), text: t, done: false });
  }
}

// Vorschlags-Knoepfe: Tippen fuegt hinzu. Im Bearbeiten-Modus loescht Tippen den
// Vorschlag (langes Druecken war auf iOS unzuverlaessig).
let editMode = false;
function chipsHtml(data, max) {
  const toggle = `<button type="button" class="chip-edit">${editMode ? "Fertig" : "✎ Bearbeiten"}</button>`;
  return toggle + Liste.suggestions(data, max).map(s =>
    `<button type="button" class="chip${editMode ? " del" : ""}${s.due && !editMode ? " due" : ""}" data-t="${esc(s.text)}"` +
    `${s.due ? ' title="Wird laut Kaufrhythmus bald fällig"' : ""}>${esc(s.text)}</button>`).join("");
}

// Kaufrhythmus: typischer Abstand (Median) aus mind. 3 Kaeufen. Faellig, wenn der
// letzte Kauf mindestens 90 % dieses Abstands zurueckliegt.
function buyInterval(f) {
  const h = (f.hist || []).map(x => new Date(x).getTime()).filter(x => !isNaN(x));
  if (h.length < 3) return null;
  const gaps = h.slice(1).map((t, i) => (t - h[i]) / 864e5).sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return med >= 1 ? med : null;
}
function isDue(f, now = Date.now()) {
  const iv = buyInterval(f);
  if (!iv || !f.hist) return false;
  const since = (now - new Date(f.hist[f.hist.length - 1]).getTime()) / 864e5;
  return since >= iv * 0.9 && since <= iv * 3;   // viel zu lange her = wohl nicht mehr gekauft
}

// ---------- REWE-Angebote (aus dem Wochenlauf des REWE-Projekts) ----------
const OFFERS_URL = "https://hannibal2404.github.io/Rewe-App/angebote.json";
const Angebote = {
  data: (() => { try { return JSON.parse(lsGet("dash_offers")); } catch { return null; } })(),
  async load() {
    try {
      const r = await fetch(OFFERS_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return this.data;
      this.data = await r.json(); this._memo = {};
      lsSet("dash_offers", JSON.stringify(this.data));
    } catch {}
    return this.data;
  },
  valid() {
    const d = this.data; if (!d || !Array.isArray(d.offers)) return false;
    const today = new Date().toLocaleDateString("sv");          // JJJJ-MM-TT
    return (!d.until || d.until >= today) && (!d.from || d.from <= today);
  },
  // Guenstigstes passendes Angebot zum Listeneintrag, sonst null
  match(text) {
    if (!this.valid()) return null;
    this._memo = this._memo || {};
    const key = text.toLowerCase().trim();
    if (key in this._memo) return this._memo[key];
    const words = key.split(/[^a-zäöüß]+/).filter(w => w.length >= 3);
    let best = null;
    if (words.length) for (const o of this.data.offers) {
      if (NOT_OFFER.test(o.name) && !words.some(w => NOT_OFFER.test(w))) continue;
      const toks = o.name.toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
      if (words.every(w => toks.some(t => wordHit(t, w))) && (!best || o.cents < best.cents)) best = o;
    }
    return (this._memo[key] = best);
  },
};
// "milch" passt zu "vollmilch", "zwiebeln" zu "gemüsezwiebel", aber "eis" nicht zu "reis"
function stem(w) { const s = w.replace(/(en|n|e|s)$/, ""); return s.length >= 3 ? s : w; }
// Zusammensetzungen, die etwas ganz anderes meinen
const NOT_A = ["buttermilch", "kokosmilch", "kondensmilch", "sonnenmilch", "reinigungsmilch", "körpermilch",
               "milchreis", "eiswürfel", "pfefferbeißer", "seelachs"];
// Fertiggerichte und Wuerzware: "Nudeln" soll keine Terrine finden, "Paprika" keine Salami
const NOT_OFFER = /terrine|rahmsauce|sauce|soße|fix|würzmischung|gewürz|kolbasz|salami|fertiggericht/i;
function wordHit(tok, w) {
  if (tok === w || stem(tok) === stem(w)) return true;
  if (NOT_A.includes(tok)) return false;
  if (w.length >= 6 && /^(filets?|stücke?|fleisch)$/.test(tok.slice(w.length)) && tok.startsWith(w)) return true;
  return (w.length >= 4 && tok.endsWith(w)) || (stem(w).length >= 4 && stem(tok).endsWith(stem(w)));
}

// ---------- Countdowns ----------
// Naechstes Datum (jaehrlich wiederkehrend oder einmalig) und Tage bis dahin
function nextEvent(e, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = String(e.date).split("-").map(Number);
  if (!y || !m || !d) return null;
  let t = new Date(e.yearly ? today.getFullYear() : y, m - 1, d);
  if (e.yearly && t < today) t = new Date(today.getFullYear() + 1, m - 1, d);
  const days = Math.round((t - today) / 864e5);
  if (days < 0) return null;
  let at = null;                                         // genauer Zeitpunkt, falls Uhrzeit angegeben
  if (/^\d{1,2}:\d{2}$/.test(e.time || "")) { const [h, mi] = e.time.split(":").map(Number); at = new Date(t); at.setHours(h, mi); }
  if (at && at < now) return null;                       // heutiger Termin ist vorbei
  const created = /^[0-9a-z]{6,}$/.test(e.id || "") ? parseInt(e.id, 36) : NaN;   // id = Anlegezeitpunkt
  return { ...e, when: t, at, days, created: created > 1.6e12 && created < Date.now() ? created : null,
           age: e.yearly && y > 1900 ? t.getFullYear() - y : null };
}
function upcomingEvents(data, withinDays = 9999) {
  return (data.events || []).map(e => nextEvent(e)).filter(e => e && e.days <= withinDays)
    .sort((a, b) => a.days - b.days);
}
// Symbol nach Stichwort, falls der Name nicht schon mit einem Emoji beginnt
const EV_ICONS = [[/barbier|friseur|haare/i, "✂️"], [/zahnarzt|zahn/i, "🦷"], [/tierarzt/i, "🐾"],
  [/arzt|praxis|termin.*dr|dr\.|klinik|physio/i, "🩺"], [/geburtstag|bday|b-day/i, "🎂"],
  [/urlaub|flug|reise|ferien/i, "✈️"], [/hochzeit/i, "💍"], [/konzert|festival/i, "🎵"],
  [/fußball|fussball|spiel|stadion/i, "⚽"], [/sport|gym|training|fitness/i, "🏋️"],
  [/tüv|werkstatt|reifen|auto/i, "🚗"], [/party|feier/i, "🎉"], [/essen|restaurant|grillen/i, "🍽️"],
  [/kino|film/i, "🎬"], [/\bamt\b|behörde|steuer/i, "📄"], [/besuch/i, "👋"]];
function evIcon(e) {
  if (/^\p{Extended_Pictographic}/u.test(e.name)) return "";
  for (const [re, ic] of EV_ICONS) if (re.test(e.name)) return ic;
  return e.yearly ? "🎂" : "📌";
}
function evTitle(e) {
  const ic = evIcon(e);
  return (ic ? ic + " " : "") + e.name + (e.age ? ` wird ${e.age}` : "");
}
// "Heute", "Morgen", "Di 1.12." bis 2 Wochen, danach "in 39 Tagen"
const WD_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
function dayLabel(e) {
  if (e.days === 0) return "Heute";
  if (e.days === 1) return "Morgen";
  if (e.days <= 14) return `${WD_SHORT[e.when.getDay()]} ${e.when.getDate()}.${e.when.getMonth() + 1}.`;
  return `in ${e.days} Tagen`;
}
// Vorfreude-Balken: einmalige Termine, die beim Anlegen mind. 14 Tage weg waren
function evProgress(e) {
  if (e.yearly || !e.created) return null;
  const total = (e.when - e.created) / 864e5;
  if (total < 14) return null;
  return Math.max(0, Math.min(1, 1 - e.days / total));
}
function daysText(n) { return n === 0 ? "heute" : n === 1 ? "morgen" : n === 2 ? "übermorgen" : `in ${n} Tagen`; }
function bindChips(root, onAdd, onHide, onToggle) {
  root.querySelectorAll(".chip").forEach(b =>
    b.addEventListener("click", () => editMode ? onHide(b.dataset.t) : onAdd(b.dataset.t)));
  const t = root.querySelector(".chip-edit");
  if (t) t.addEventListener("click", () => { editMode = !editMode; onToggle(); });
}

// Link zum Anlegen des Schluessels: klassischer Token, nur Recht "gist".
const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=gist&description=K%C3%BCchen-Dashboard";

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Neue Version der Seite? Dann neu laden (iPad haengt sonst ewig auf dem alten Stand).
function watchForUpdates(everyMin = 10) {
  let first = null;
  const check = async () => {
    try {
      const r = await fetch(location.pathname, { method: "HEAD", cache: "no-store" });
      const tag = r.headers.get("etag") || r.headers.get("last-modified");
      if (!tag) return;
      if (first === null) first = tag;
      else if (tag !== first) location.reload();
    } catch {}
  };
  check();
  setInterval(check, everyMin * 60 * 1000);
}
