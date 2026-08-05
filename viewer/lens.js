/* lens.js - the plankton lens: every plot becomes a window into where it came from.
 *
 * Include it once, point it at one or more "connected planktons" (registries), and every plot on
 * the page gets checked: lens.js fetches the image bytes, SHA-256s them, and asks the connected
 * planktons "do you know this file?". For the ones a plankton knows, a small plankton-logo lens
 * appears in the corner - the presence of the logo means "diggable". Click it and the kton world
 * opens: the record is verified in your browser (Ed25519/DSSE via the WASM kernel) and the whole
 * lineage unfolds in the viewer, focused on that plot. Nothing is uploaded.
 *
 *   <script src="lens.js"
 *           data-planktons="data/lens-paper/union.json"      (comma-separated registry URLs)
 *           data-viewer="viewer.html"></script>
 * and mark your plots:  <img class="lens" src="fig1.svg">   (or any <img data-kton>)
 *
 * Badge states (a plot with NO badge is simply unknown to your planktons - the page stays clean):
 *   green  ring - verified here (signature re-checked) AND your bytes are the recorded bytes
 *   amber  ring - known & content matches, but this browser can't do Ed25519 (open to verify)
 *   grey   ring - known by hash, shown without a key to verify against
 *   ↻N counter - reproduced: N independent fotons produced these exact bytes (the more, the stronger the corroboration)
 */
(function () {
  "use strict";
  var S = document.currentScript;
  var CFG = {
    planktons: (S.getAttribute("data-planktons") || "union.json").split(",").map(function (s) { return s.trim(); }).filter(Boolean),
    viewer: S.getAttribute("data-viewer") || "viewer.html",
    logo: S.getAttribute("data-logo") || "logo.png",
    selector: S.getAttribute("data-selector") || "img.lens,img[data-kton]",
    mirror: S.getAttribute("data-mirror") || "",   // a STATIC content-addressed mirror: fetch by hash, never load a whole union
  };

  /* ---------- crypto: SHA-256 (universal) + Ed25519/DSSE (like example 13, where supported) ------- */
  function hex(buf) { return [].map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
  function hexToBytes(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function b64ToBytes(b) { var s = atob(b), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  async function sha256(bytes) { return "sha256:" + hex(await crypto.subtle.digest("SHA-256", bytes)); }
  function pae(t, p) { var e = new TextEncoder(), tb = e.encode(t), pre = e.encode("DSSEv1 " + tb.length + " " + t + " " + p.length + " "), o = new Uint8Array(pre.length + p.length); o.set(pre, 0); o.set(p, pre.length); return o; }
  async function verifySig(rec, keys) {                 // true / false / null(unknown - degrade honestly)
    var env = rec && rec.envelope; if (!env || !env.payload) return null;
    var msg = pae(env.payloadType || "application/vnd.in-toto+json", b64ToBytes(env.payload)), saw = false;
    for (var i = 0; i < (env.signatures || []).length; i++) {
      var pub = keys[env.signatures[i].keyid]; if (!pub) continue; saw = true;
      try {
        var k = await crypto.subtle.importKey("raw", hexToBytes(pub), { name: "Ed25519" }, false, ["verify"]);
        if (await crypto.subtle.verify({ name: "Ed25519" }, k, b64ToBytes(env.signatures[i].sig), msg)) return true;
      } catch (e) { return null; }                      // no WebCrypto Ed25519 here
    }
    return saw ? false : null;
  }

  /* ---------- connected planktons: load each registry, index every file it knows ----------------- */
  var IDX = {};   // hash -> { outs:[{rec,reg,keys}], ins:[...] } - EVERY producer, not just the first
  function regUrls(union) { var b = union.replace(/[^/]*$/, ""); return { union: union, keys: b + "keys.json", names: b + "names.json" }; }
  // distinct producing fotons of a hash (same bytes from N fotons = reproduction) - dedup across registries by id
  function distinctProducers(outs) { var seen = {}, out = []; (outs || []).forEach(function (e) { var id = e.rec.fotonId || e.rec.claimId; if (id && !seen[id]) { seen[id] = 1; out.push(e); } }); return out; }
  function distinctSigners(list) { var s = {}; (list || []).forEach(function (e) { var sg = e.rec.envelope && e.rec.envelope.signatures && e.rec.envelope.signatures[0] && e.rec.envelope.signatures[0].keyid; if (sg) s[sg] = 1; }); return Object.keys(s).length; }
  function sigOf(rec) { return rec && rec.envelope && rec.envelope.signatures && rec.envelope.signatures[0] && rec.envelope.signatures[0].keyid; }
  // is this record a `reproduces` claim? (predicate IRI lives at payload.predicate.predicate.uri; also accept a bare string)
  function isReproduces(rec) { try { var p = JSON.parse(atob(rec.envelope.payload)); var pr = p && p.predicate && p.predicate.predicate; return /reproduc/i.test(String((pr && (pr.uri || pr)) || "")); } catch (e) { return false; } }
  // Distinct signers who VOUCH for these exact bytes. A foton is IMMUTABLE: an identical rerun dedups to
  // ONE object, so corroboration is NOT producer-foton multiplicity - it is counted at the ATTESTATION
  // layer. An attester is (a) the author of a producing foton, or (b) the signer of a `reproduces` claim
  // whose subject is a producing foton. Returns the union set of keyids.
  function reproSigners(prods) {
    var s = {};
    (prods || []).forEach(function (e) {
      var kid = sigOf(e.rec); if (kid) s[kid] = 1;                          // (a) producing = attesting
      var fid = e.rec.fotonId; if (!fid) return;
      var about = IDX[/^sha256:/.test(fid) ? fid : "sha256:" + fid];        // reproduces claims carry the foton id as subject -> refs
      ((about && about.refs) || []).forEach(function (c) { if (isReproduces(c.rec)) { var sg = sigOf(c.rec); if (sg) s[sg] = 1; } });
    });
    return Object.keys(s);
  }
  // the reader's OWN connected planktons (e.g. set in Teams), unioned onto whatever the embedding delivers:
  // the same file may then resolve to MORE (you know things the sender did not ship) or LESS (it points at
  // a plankton you are not connected to). Stored as a JSON array or comma list under localStorage "kton-planktons".
  function readerPlanktons() { try { var v = localStorage.getItem("kton-planktons"); if (!v) return []; try { return JSON.parse(v); } catch (e) { return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean); } } catch (e) { return []; } }
  async function loadPlanktons() {
    var list = CFG.planktons.slice();                                       // (1) delivered with the embedding
    readerPlanktons().forEach(function (u) { if (list.indexOf(u) < 0) list.push(u); });  // (2) your own connected planktons
    for (var u = 0; u < list.length; u++) {
      var reg = regUrls(list[u]);
      var union, keys = {};
      try { union = await (await fetch(reg.union)).json(); } catch (e) { continue; }
      try { keys = await (await fetch(reg.keys)).json(); } catch (e) {}
      union.forEach(function (r) {
        if (!r || !r.envelope) return;
        var p; try { p = JSON.parse(atob(r.envelope.payload)); } catch (e) { return; }
        function add(s, role) {                                            // role: "outs" (produced) | "ins" (consumed) | "refs" (a claim's subject)
          var d = s.digest && (s.digest.sha256 || s.digest["sha-256"]); if (!d) return;
          var key = "sha256:" + d.toLowerCase(), e = IDX[key] || (IDX[key] = { outs: [], ins: [], refs: [] });
          e[role].push({ rec: r, reg: reg, keys: keys });                  // collect EVERY producer - N fotons that made the same bytes all count (reproduction)
        }
        if (r.fotonId) {                                                   // a FOTON: its subjects are OUTPUTS it produced; predicate.inputs are what it consumed
          (p.subject || []).forEach(function (s) { add(s, "outs"); });
          ((p.predicate && p.predicate.inputs) || []).forEach(function (s) { add(s, "ins"); });
        } else {                                                           // a CLAIM: its subject is what it is ABOUT - a reference, NOT a production
          (p.subject || []).forEach(function (s) { add(s, "refs"); });
        }
      });
    }
  }

  /* ---------- LAZY mode: a static content-addressed mirror (the rainbow table of executions) ---------
   * Never loads a union. For a file hash H: GET output/sha256/H -> [producer foton ids], then GET each
   * object by id. Every object is re-hashable to its id, so the mirror can withhold but cannot forge.
   * Scales to any number of records - you fetch only the hashes you look at. */
  var mkeys = null, mnames = null;
  function shard(h) { h = String(h).replace(/^sha256:/, "").toLowerCase(); return h.slice(0, 2) + "/" + h; }  // 2-hex prefix, matches build_mirror.py
  async function mget(path) { try { var r = await fetch(CFG.mirror.replace(/\/$/, "") + "/" + path); return r.ok ? await r.json() : null; } catch (e) { return null; } }
  async function mObject(id) { return mget("objects/sha256/" + shard(id) + ".json"); }
  // list an APPEND-ONLY marker prefix -> producer ids. Reading = list the prefix; appending = drop one file
  // (nothing is ever rewritten). Here via directory autoindex (http.server/nginx/apache); an object-storage
  // host would use its LIST API. ↻N is just the count of markers - free from the listing, no content fetched.
  async function listMarkers(kind, hash) {
    try {
      var r = await fetch(CFG.mirror.replace(/\/$/, "") + "/" + kind + "/sha256/" + shard(hash) + "/");
      if (!r.ok) return [];
      var html = await r.text(), ids = [], re = /href="([0-9a-f]{64})\.json"/gi, m;
      while ((m = re.exec(html))) ids.push("sha256:" + m[1]);
      return ids.filter(function (v, i, a) { return a.indexOf(v) === i; });
    } catch (e) { return []; }
  }
  async function lazyLookup(hash) {
    var ids = await listMarkers("output", hash);                          // who executed these bytes? (↻N is just the marker count)
    if (!ids.length) return null;
    var rec = await mObject(ids[0]); if (!rec) return null;               // the primary producer's record (for verify + pedigree)
    var nsign = 0;
    if (ids.length <= 24) {                                               // signer count from the tiny markers (skip when hugely reproduced)
      var s = {};
      for (var i = 0; i < ids.length; i++) { var mk = await mget("output/sha256/" + shard(hash) + "/" + ids[i].replace(/^sha256:/, "") + ".json");   // marker {by} OR (symlink followed) the record itself
        var kid = mk && (mk.by || (mk.envelope && mk.envelope.signatures && mk.envelope.signatures[0] && mk.envelope.signatures[0].keyid)); if (kid) s[kid] = 1; }
      nsign = Object.keys(s).length;
    }
    return { rec: rec, nprod: ids.length, nsign: nsign };
  }

  /* ---------- the lens badge + the "kton world" overlay ------------------------------------------- */
  var CSS = "\
.lens-wrap{position:relative;display:inline-block;line-height:0}\
.lens-badge{position:absolute;right:8px;bottom:8px;width:30px;height:30px;border-radius:50%;\
  background:#fff center/70% no-repeat;box-shadow:0 1px 5px rgba(0,0,0,.28);border:2px solid var(--lc,#9aa4b2);\
  cursor:pointer;transition:transform .12s,box-shadow .12s;z-index:2}\
.lens-badge:hover{transform:scale(1.12);box-shadow:0 3px 12px rgba(0,0,0,.36)}\
.lens-badge:focus-visible{outline:2px solid #3a45cf;outline-offset:2px}\
.lens-ok{--lc:#12b886} .lens-av{--lc:#e0932a} .lens-un{--lc:#9aa4b2}\
.lens-rep{position:absolute;right:5px;bottom:31px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;\
  background:#12b886;color:#fff;font:700 10px/17px ui-sans-serif,system-ui,sans-serif;text-align:center;\
  box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;z-index:3}\
.lens-tip{position:absolute;right:8px;bottom:44px;max-width:280px;background:#0f131a;color:#e8ebf2;\
  font:12px/1.5 ui-sans-serif,system-ui,sans-serif;padding:8px 11px;border-radius:9px;box-shadow:0 6px 22px rgba(0,0,0,.4);\
  opacity:0;pointer-events:none;transform:translateY(4px);transition:.14s;z-index:3}\
.lens-badge:hover+.lens-tip,.lens-tip:hover{opacity:1;transform:translateY(0)}\
.lens-tip b{color:#fff} .lens-tip .v{color:#4fd39a} .lens-tip .m{color:#98a1b2}\
.lens-ov{position:fixed;inset:0;z-index:99999;background:rgba(10,14,22,.62);backdrop-filter:blur(2px);display:flex;flex-direction:column;padding:22px}\
.lens-ov header{display:flex;align-items:center;gap:12px;color:#fff;font:600 13px ui-sans-serif,system-ui,sans-serif;padding:0 2px 12px}\
.lens-ov header .h{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
.lens-ov header code{font:11px ui-monospace,Menlo,monospace;opacity:.7}\
.lens-ov .x{all:unset;cursor:pointer;color:#fff;background:rgba(255,255,255,.14);border-radius:8px;padding:5px 13px;font:600 12px ui-sans-serif,system-ui,sans-serif}\
.lens-ov .x:hover{background:rgba(255,255,255,.24)}\
.lens-ov iframe{flex:1;width:100%;border:0;border-radius:12px;background:#0f131a;box-shadow:0 14px 50px rgba(0,0,0,.5)}\
";
  function inject() { var s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); }

  function openWorld(hit, hash) {
    // the registry paths are relative to THIS page; the viewer is a different file that would resolve
    // them relative to itself. Resolve them to absolute against our base once (the one place it's needed).
    var abs = function (u) { try { return new URL(u, document.baseURI).href; } catch (e) { return u; } };
    var q = new URLSearchParams({ union: abs(hit.reg.union), keys: abs(hit.reg.keys), names: abs(hit.reg.names), focus: hash });
    var ov = document.createElement("div"); ov.className = "lens-ov";
    ov.innerHTML = '<header><span class="h">where this came from &middot; <code>' + hash.slice(0, 23) + '&hellip;</code></span><button class="x">Close&nbsp; Esc</button></header>' +
      '<iframe title="kton provenance" src="' + CFG.viewer + "?" + q.toString() + '"></iframe>';
    function close() { ov.remove(); document.removeEventListener("keydown", onk); }
    function onk(e) { if (e.key === "Escape") close(); }
    ov.querySelector(".x").onclick = close;
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.addEventListener("keydown", onk);
    document.body.appendChild(ov);
  }

  function pedigree(rec, names) {
    var p; try { p = JSON.parse(atob(rec.envelope.payload)); } catch (e) { return {}; }
    var proto = ((p.predicate || {}).protocol || {}).descriptor || {};
    var kid = rec.envelope.signatures && rec.envelope.signatures[0] && rec.envelope.signatures[0].keyid;
    return { cmd: proto.cmd, by: (names && names[kid]) || kid, ins: ((p.predicate || {}).inputs || []).map(function (i) { return i.name; }).filter(Boolean) };
  }

  function attach(img, hash, hit, state, names, nprod, nsign) {
    var wrap = document.createElement("span"); wrap.className = "lens-wrap";
    img.parentNode.insertBefore(wrap, img); wrap.appendChild(img);
    var b = document.createElement("button");
    b.className = "lens-badge lens-" + state; b.style.backgroundImage = "url(" + CFG.logo + ")";
    b.setAttribute("aria-label", "provenance available - open the kton world");
    var ped = pedigree(hit.rec, names);
    var nrep = Math.max(nsign || 0, nprod || 0);                  // corroboration = distinct ATTESTERS (producer authors ∪ reproduces-claim signers); immutable fotons dedup, so this - not producer count - is ↻N
    var repro = nrep > 1;
    var tip = document.createElement("div"); tip.className = "lens-tip";
    var vline = state === "ok" ? '<span class="v">✓ verified here</span>' : state === "av" ? '<span class="m">● known · open to verify</span>' : '<span class="m">● known by hash</span>';
    var repline = repro ? '<span class="v">↻ reproduced · ' + nrep + ' signers' + (nprod > 1 ? ' · ' + nprod + ' fotons' : '') + '</span><br>' : '';
    tip.innerHTML = repline + vline + '<br><b>' + (ped.by || "?") + '</b>' + (ped.cmd ? '<br><span class="m">via</span> ' + ped.cmd : "") + (ped.ins && ped.ins.length ? '<br><span class="m">from</span> ' + ped.ins.join(", ") : "") + '<br><span class="m">click to dig into where it came from</span>';
    b.onclick = function () { openWorld(hit, hash); };
    wrap.appendChild(b);
    if (repro) { var rp = document.createElement("span"); rp.className = "lens-rep"; rp.textContent = "↻" + nrep;
      rp.title = nrep + " independent signers attest these exact bytes (reproduced) — producing a foton OR signing a reproduces claim about it"; wrap.appendChild(rp); }
    wrap.appendChild(tip);
  }

  async function run() {
    if (!(window.crypto && crypto.subtle)) return;              // needs https or localhost
    var imgs = [].slice.call(document.querySelectorAll(CFG.selector));
    if (!imgs.length) return;
    inject();
    var LAZY = !!CFG.mirror;
    if (LAZY) { mkeys = await mget("keys.json") || {}; mnames = await mget("names.json") || {}; }  // (at scale these become indexes too)
    else await loadPlanktons();
    var openReg = CFG.planktons.length ? regUrls(CFG.planktons[0]) : null;   // for the clickable deep-dive (viewer loads it on click)
    var namesCache = {};
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute("data-kton") || img.currentSrc || img.src;   // data-kton may be a literal hash
      var hash, bytes = null;
      if (/^sha256:[0-9a-f]{64}$/i.test(src)) { hash = src.toLowerCase(); }
      else { try { bytes = await (await fetch(src)).arrayBuffer(); hash = await sha256(bytes); } catch (e) { continue; } }
      var hit, names, nprod, nsign;
      if (LAZY) {                                                // fetch by hash from the mirror - no union ever loaded
        var L = await lazyLookup(hash); if (!L) continue;
        hit = { rec: L.rec, reg: openReg || { union: "", keys: "", names: "" }, keys: mkeys };
        names = mnames; nprod = L.nprod; nsign = L.nsign;
      } else {
        var entry = IDX[hash]; if (!entry) continue;             // unknown to every connected plankton -> no badge
        var prods = distinctProducers(entry.outs);              // every foton that OUTPUT these exact bytes = a reproduction
        hit = prods[0] || entry.ins[0] || entry.refs[0];        // prefer a PRODUCER (where it came from); else consumer; else a claim ref
        names = namesCache[hit.reg.names]; if (names === undefined) { try { names = await (await fetch(hit.reg.names)).json(); } catch (e) { names = {}; } namesCache[hit.reg.names] = names; }
        nprod = prods.length; nsign = reproSigners(prods).length;   // attesters = producer authors ∪ reproduces-claim signers
      }
      var v = bytes ? await verifySig(hit.rec, hit.keys) : null;  // content already matches (hash came from the bytes)
      attach(img, hash, hit, v === true ? "ok" : v === false ? "un" : "av", names, nprod, nsign);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
