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
    return r.json();
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
    const g = await this.api("/gists/" + await this.gistId());
    let data;
    try { data = JSON.parse(g.files[LIST_FILE].content); } catch { data = null; }
    if (!data || !Array.isArray(data.items)) data = { items: [] };
    lsSet(LS_CACHE, JSON.stringify(data));
    return data;
  },

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

  add(text) {
    text = text.trim();
    if (!text) return Promise.resolve(this.cached());
    return this.change(d => {
      const same = d.items.find(i => i.text.toLowerCase() === text.toLowerCase());
      if (same) { same.done = false; return; }        // schon drauf -> wieder offen
      d.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                     text, done: false, added: new Date().toISOString() });
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
