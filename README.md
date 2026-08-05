# plankton federation

A **neutral aggregator** for a federation of independent plankton/nekton repos. It mirrors registered
participants, **verifies every signature**, and serves one federated provenance view where each result shows
its **`↻N`** — how many independent signers produced those exact bytes. It mirrors and verifies; it never
vouches. Admission decides *whose records appear here*, not whether they are authentic.

## Make it your federation (3 steps)
1. **Use this template → Create a new repository.**
2. **Settings → Actions → General →** allow workflows to *read and write* (so `mirror.yml` can commit).
3. **Settings → Pages →** deploy from `main`. Your federated viewer is then at
   `https://<you>.github.io/<repo>/viewer/viewer.html`.

That's it. Edit this README's title to name your federation.

## How participants join
A participant opens a **[Register a participant](../../issues/new?template=register-participant.yml)** issue
with their repo (`owner/repo`) and a mirror interval. You admit them by adding the **`approved`** label — the
`register` workflow appends them to `participants.json` and the aggregator starts mirroring on their interval.

## How mirroring works
`mirror.yml` runs every 5 minutes but does almost nothing unless someone published: for each participant it
asks GitHub *"is the `registry/` commit new?"* (one API call) — if not, it skips. When there is new work it
fetches only the new objects, **verifies each Ed25519 signature** against the participant's published `.pub`
keys (dropping anything that fails), and appends the verified records to `mirror/` (append-only, content-
addressed). Frequent scheduling is therefore cheap, and new work shows up within minutes. Trigger it now from
the **Actions → mirror → Run workflow** button.

## Layout
```
participants.json     the registered sources (name, repo, interval) — filled by the register workflow
templates/            the canonical nekton claim templates (reproduces, working-on)
viewer/               the federated viewer (reads mirror/) — served by Pages
mirror/               the aggregate: verified records from all participants (append-only)
bin/                  plankton, nekton  (used to verify signatures on ingest)
scripts/              mirror_once.py (the aggregation), build_mirror.py, register.py
.github/              the register + mirror workflows and the registration issue form
```

To spin up a participant, start from **`plankton-participant-template`** — fork it, run its `CLAUDE.md` loop,
push your registry, and register here.
