#!/usr/bin/env python3
"""build_mirror.py - turn records into a STATIC, APPEND-ONLY, content-addressed mirror.

Objects are immutable and named by their content hash. The reverse index (who produced /
consumed / attested a hash) is a directory of one immutable MARKER per producer - so a new
foton just DROPS a marker; nothing is ever rewritten. That inherits plankton's drift:
idempotent, order-independent, no coordination. Reading = list the prefix.

  objects/sha256/<ab>/<id>.json         the record itself (immutable), 2-hex sharded
  output/sha256/<ab>/<hash>/<pid>.json  one marker per foton that OUTPUT these bytes  (the rainbow table)
  input/sha256/<ab>/<hash>/<pid>.json   one marker per foton that CONSUMED it
  about/sha256/<ab>/<hash>/<pid>.json   one marker per claim ABOUT this subject
  keys.json / names.json                copied (batch build only)

A marker's filename is the producer id; its tiny body is {"by": <signer keyid>} so the
count (↻N) is free from the listing and signers need only small marker reads, not full objects.

Usage:
  build_mirror.py <union.json> <out-dir>          full build   (also copies keys/names)
  build_mirror.py --add <records.json> <out-dir>  append new records (idempotent; no rewrite)
"""
import json, os, sys, base64

args = sys.argv[1:]
add_mode = "--add" in args
if add_mode: args.remove("--add")
symlink_mode = "--symlink" in args           # index entries as 0-byte symlinks (filesystem/nginx/IPFS) vs marker files (object storage)
if symlink_mode: args.remove("--symlink")
recs_path, out_dir = args[0], args[1]
recs = json.load(open(recs_path))
strip = lambda h: (h or "").replace("sha256:", "").lower()
shard = lambda h: h[:2] + "/" + h

def put(path, data):
    """write once - never overwrite (append-only / idempotent). returns True if newly written."""
    if os.path.exists(path): return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(data, open(path, "w"), separators=(",", ":"))
    return True

def obj_path(rid):        return os.path.join(out_dir, "objects", "sha256", shard(strip(rid)) + ".json")
def marker(kind, h, pid): return os.path.join(out_dir, kind, "sha256", h[:2], h, strip(pid) + ".json")

def put_index(kind, h, pid, signer):
    """Append ONE index entry - never rewrite. --symlink: a 0-byte symlink to the object (dedup; list + follow
    gives the record). Default: a tiny {by} marker (for object-storage hosts that have no symlinks). Either way
    the entry's NAME is the producer hash, so listing the prefix yields the producers regardless of encoding."""
    path = marker(kind, h, pid)
    if os.path.lexists(path): return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if symlink_mode:
        os.symlink(os.path.relpath(obj_path(pid), os.path.dirname(path)), path)   # entry -> the single stored object
    else:
        json.dump({"by": signer}, open(path, "w"), separators=(",", ":"))
    return True

n_obj = n_mark = 0
for r in recs:
    rid = r.get("fotonId") or r.get("claimId")
    if not rid or not r.get("envelope"): continue
    if put(obj_path(rid), r): n_obj += 1
    try: p = json.loads(base64.b64decode(r["envelope"]["payload"]))
    except Exception: continue
    signer = (r["envelope"].get("signatures") or [{}])[0].get("keyid", "")
    dig = lambda s: strip((s.get("digest") or {}).get("sha256") or "")
    if r.get("fotonId"):                                          # FOTON: subjects=OUTPUTS, predicate.inputs=consumed
        for s in p.get("subject", []) or []:
            h = dig(s); n_mark += 1 if (h and put_index("output", h, rid, signer)) else 0
        for s in (p.get("predicate", {}) or {}).get("inputs", []) or []:
            h = dig(s); n_mark += 1 if (h and put_index("input", h, rid, signer)) else 0
    else:                                                        # CLAIM: subject=what it is ABOUT
        for s in p.get("subject", []) or []:
            h = dig(s); n_mark += 1 if (h and put_index("about", h, rid, signer)) else 0

if not add_mode:
    base = os.path.dirname(recs_path)
    for f in ("keys.json", "names.json"):
        src = os.path.join(base, f)
        if os.path.exists(src): json.dump(json.load(open(src)), open(os.path.join(out_dir, f), "w"), separators=(",", ":"))

print("%s: +%d objects, +%d markers  ->  %s" % ("add" if add_mode else "build", n_obj, n_mark, out_dir))
