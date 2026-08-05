#!/usr/bin/env python3
"""mirror_once.py - mirror every registered participant that has NEW work, verify it, aggregate it.

A participant is just a GitHub repo that committed its `registry/` (fotons under registry/plankton/,
claims under registry/nekton/, pubkeys under registry/keys/). There is NO publish step: the committed
registry IS the published, content-addressed, signed record set. This script reads it directly.

For each active + due participant in participants.json:
  1. Ask GitHub for the latest commit sha touching `registry/`. If it equals the stored `last_commit`,
     there is NOTHING NEW -> skip (one API call). This is what lets the schedule run often for cheap.
  2. List that commit's tree (one API call) -> the set of object files (= object hashes) + the .pub keys.
  3. Fetch, over raw URLs, only the objects we have not mirrored yet, plus the pubkeys.
  4. VERIFY each record: Ed25519 signature valid under the participant's published pubkey (bin/plankton|
     nekton verify). A record that fails is DROPPED, not mirrored (withhold-not-forge: verify, never vouch).
  5. build_mirror.py --add the verified records into mirror/ (append-only, idempotent, ↻N markers).
  6. Record last_commit + last_run.

Usage: mirror_once.py [--force]   (--force ignores the per-participant interval)
"""
import json, os, sys, subprocess, tempfile, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTICIPANTS = os.path.join(ROOT, "participants.json")
MIRROR = os.path.join(ROOT, "mirror")
BIN = os.path.join(ROOT, "bin")
FORCE = "--force" in sys.argv
TOKEN = os.environ.get("GITHUB_TOKEN", "")
API, RAW = "https://api.github.com", "https://raw.githubusercontent.com"

def now(): return datetime.now(timezone.utc)

def _req(url, raw=False):
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json" if not raw else "*/*")
    with urllib.request.urlopen(req, timeout=30) as r:
        b = r.read()
    return b if raw else json.loads(b)

def due(p):
    if FORCE or not p.get("last_run"):
        return True
    try:
        last = datetime.fromisoformat(p["last_run"].replace("Z", "+00:00"))
    except Exception:
        return True
    return (now() - last).total_seconds() >= p.get("interval_minutes", 60) * 60

def latest_commit(repo, branch):
    j = _req(f"{API}/repos/{repo}/commits?path=registry&sha={branch}&per_page=1")
    return j[0]["sha"] if j else None

def tree(repo, sha):
    j = _req(f"{API}/repos/{repo}/git/trees/{sha}?recursive=1")
    return [e["path"] for e in j.get("tree", []) if e["type"] == "blob"]

def record_id(rec): return rec.get("fotonId") or rec.get("claimId") or ""

def verify_sig(rec, keys):
    sigs = rec.get("envelope", {}).get("signatures", [])
    if not sigs:
        return False
    pub = keys.get(sigs[0].get("keyid", ""))
    if not pub:
        return False
    tool = "plankton" if "fotonId" in rec else "nekton"
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(rec, f); path = f.name
    try:
        r = subprocess.run([os.path.join(BIN, tool), "verify", path, pub], capture_output=True, text=True)
        return r.returncode == 0 and "VALID" in r.stdout
    finally:
        os.unlink(path)

def mirrored_ids():
    seen, objdir = set(), os.path.join(MIRROR, "objects", "sha256")
    if os.path.isdir(objdir):
        for sh in os.listdir(objdir):
            d = os.path.join(objdir, sh)
            if os.path.isdir(d):
                seen.update("sha256:" + fn[:-5] for fn in os.listdir(d) if fn.endswith(".json"))
    return seen

def keyid_of(hexpub):
    import hashlib
    try: return hashlib.sha256(bytes.fromhex(hexpub)).hexdigest()[:16]
    except Exception: return None

def main():
    participants = json.load(open(PARTICIPANTS))
    already = mirrored_ids()
    changed = False
    allkeys, allnames = {}, {}
    for p in participants:
        if not p.get("active", True) or not due(p):
            continue
        name, repo, branch = p.get("name", "?"), p["repo"], p.get("branch", "main")
        try:
            head = latest_commit(repo, branch)
        except Exception as e:
            print(f"[{name}] unreachable: {e}"); continue
        if head and head == p.get("last_commit"):
            print(f"[{name}] nothing new (registry @ {head[:9]}) - skip")
            p["last_run"] = now().isoformat(); continue
        try:
            paths = tree(repo, head)
        except Exception as e:
            print(f"[{name}] tree failed: {e}"); continue
        # pubkeys: keyid -> hex
        keys = {}
        for path in [p for p in paths if p.startswith("registry/keys/") and p.endswith(".pub")]:
            try:
                hexpub = _req(f"{RAW}/{repo}/{head}/{path}", raw=True).decode().strip()
                kid = keyid_of(hexpub)
                if kid: keys[kid] = hexpub
            except Exception:
                pass
        allkeys.update(keys)
        for kid in keys:            # attribute each key to this participant, so the viewer shows WHO produced what
            allnames[kid] = name
        # object records not yet mirrored
        objs = [p for p in paths if (p.startswith("registry/plankton/objects/") or
                                     p.startswith("registry/nekton/objects/")) and p.endswith(".json")]
        fresh, verified, dropped = [], 0, 0
        for path in objs:
            rid = "sha256:" + os.path.basename(path)[:-5]
            if rid in already:
                continue
            try:
                rec = json.loads(_req(f"{RAW}/{repo}/{head}/{path}", raw=True))
            except Exception:
                dropped += 1; continue
            if verify_sig(rec, keys):
                fresh.append(rec); already.add(record_id(rec)); verified += 1
            else:
                dropped += 1
        if fresh:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump(fresh, f); recs = f.name
            subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "build_mirror.py"),
                            "--add", recs, MIRROR], check=True)
            os.unlink(recs); changed = True
        p["last_commit"] = head
        p["last_run"] = now().isoformat()
        print(f"[{name}] +{verified} verified, {dropped} dropped (registry @ {head[:9]})")
    json.dump(participants, open(PARTICIPANTS, "w"), indent=2)
    # rebuild union.json + keys.json for the viewer (union mode) from the aggregated objects
    import glob
    objs = []
    for f in sorted(glob.glob(os.path.join(MIRROR, "objects", "sha256", "*", "*.json"))):
        try: objs.append(json.load(open(f)))
        except Exception: pass
    json.dump(objs, open(os.path.join(MIRROR, "union.json"), "w"), separators=(",", ":"))
    keyspath = os.path.join(MIRROR, "keys.json")
    merged = {}
    if os.path.exists(keyspath):
        try: merged = json.load(open(keyspath))
        except Exception: pass
    merged.update(allkeys)
    json.dump(merged, open(keyspath, "w"), separators=(",", ":"), sort_keys=True)
    namespath = os.path.join(MIRROR, "names.json")
    mnames = {}
    if os.path.exists(namespath):
        try: mnames = json.load(open(namespath))
        except Exception: pass
    mnames.update(allnames)
    json.dump(mnames, open(namespath, "w"), separators=(",", ":"), sort_keys=True)
    print("mirror changed" if changed else "no change")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as gh:
            gh.write(f"changed={'true' if changed else 'false'}\n")

if __name__ == "__main__":
    main()
