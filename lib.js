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
      f.n += 1; f.last = new Date().toISOString();
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
  suggestions(data, max = 14) {
    const open = new Set(data.items.filter(i => !i.done).map(i => i.text.toLowerCase()));
    const learned = Object.values(data.freq || {}).sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)));
    const out = [], seen = new Set();
    for (const f of [...learned, ...STARTER.map(text => ({ text }))]) {
      const k = f.text.toLowerCase();
      if (seen.has(k) || open.has(k) || (data.hidden || []).includes(k)) continue;
      seen.add(k); out.push(f.text);
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

// Vorschlags-Knoepfe: Tippen fuegt hinzu, lange druecken blendet den Vorschlag aus.
function chipsHtml(data, max) {
  return Liste.suggestions(data, max).map(t => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join("");
}
function bindChips(root, onAdd, onHide) {
  root.querySelectorAll(".chip").forEach(b => {
    let timer = null, long = false;
    b.addEventListener("pointerdown", () => { long = false; timer = setTimeout(() => { long = true; onHide(b.dataset.t); }, 650); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => b.addEventListener(ev, () => clearTimeout(timer)));
    b.addEventListener("contextmenu", e => e.preventDefault());
    b.addEventListener("click", () => { if (!long) onAdd(b.dataset.t); });
  });
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
