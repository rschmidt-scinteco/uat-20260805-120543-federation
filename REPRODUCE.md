# Reproduce the run: cooperative "Claude science" over a kton federation

**What you'll show:** several independent Claude sessions, each in its *own* GitHub repo, sharing nothing but
published signed records, cooperatively reproduce a small pipeline over `data/penguins.csv`. A neutral
aggregator mirrors them, **re-verifies every signature**, and shows each result's **↻N** — how many
independent signers produced those exact bytes. Our run reached **↻4** across four repos.

## You need
- A GitHub account + the `gh` CLI, authenticated (`gh auth login`).
- Claude Code (or any way to run a fresh Claude session per participant).
- Python 3 with `numpy` (the pipeline is numpy-only; no pandas).

## 1. Make your aggregator (one)
```bash
gh repo create <you>/my-federation --template gitmick/plankton-federation-template --public
```
Then in that repo's GitHub **Settings**: Actions → allow *read and write*; Pages → deploy from `main`.
Your federated viewer will be at
`https://<you>.github.io/my-federation/viewer/viewer.html?union=../mirror/union.json`.

## 2. Make your participants (three or more)
```bash
for who in alice bob carol; do
  gh repo create <you>/participant-$who --template gitmick/plankton-participant-template --public
done
```

## 3. Run one cold Claude session per participant
Clone a participant repo, `cd` in, and start a **fresh** Claude session with only this instruction:

> You are a kton federation participant. Read `CLAUDE.md` and `README.md` in this repo — they are your
> complete brief. Make your signing identity, reproduce the `clean → standardise → cluster → summarise`
> pipeline over `data/penguins.csv` following the determinism checklist, **publish with commit-pinned git
> permalinks** (commit the files first, then author the fotons), and push. To cooperate, fetch the
> federation's current view from your aggregator's `mirror/union.json`, reproduce any step with `↻ < 2`,
> and sign a `reproduces` claim about an existing producer foton. Coordinate only through the published
> records — do not message the other sessions.

Repeat for each participant (a distinct session each). They never talk to each other — the registry is the
only channel. Because the pipeline is deterministic, independent runs produce byte-identical outputs.

## 4. Register each participant with your aggregator
On your `my-federation` repo, open a **"Register a participant"** issue for each one (give its `owner/repo`
and a mirror interval), then add the **`approved`** label. The aggregator appends it and mirrors it on
schedule. To see it immediately: **Actions → mirror → Run workflow**.

## 5. Watch it converge
Open your viewer. Each pipeline step shows **↻N** — the number of independent participants who produced
those exact bytes, every signature re-verified in your browser. That number climbing across independent
repos *is* the result. For a **headless** check (the aggregate is a static mirror, not a plain
`PLANKTON_DIR`), read its markers — each output hash's ↻N is the number of distinct signers across its
producer markers:
```bash
python3 - <<'EOF'
import json, glob, os
for d in sorted(glob.glob('mirror/output/sha256/*/*')):
    signers = {json.load(open(m)).get('by') for m in glob.glob(d + '/*.json')}
    print(f"↻{len(signers)}  {os.path.basename(d)[:16]}…")
EOF
```

## What to expect
- Every step reaches **↻N** (N = participants), because independent deterministic runs match byte-for-byte.
- The aggregator **drops any record whose signature does not verify** — it federates and verifies, it never vouches.
- Each foton carries a commit-pinned `raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>` locator, so anyone
  can fetch the exact input/output bytes and confirm they re-hash to the recorded value.

## One gotcha
Keep your **private** keys out of git but your **public** keys in. In each participant, `keys/*.key` is
private (gitignore it with an *anchored* `/keys/`), while `registry/keys/*.pub` **must be committed** (the
aggregator needs them to verify you). Check with `git ls-files registry/keys` before you push.
