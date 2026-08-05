# Design (short)

**Participant = a repo that committed its `registry/`.** No publish step: the committed registry is already
the content-addressed, signed record set. Data/scripts/outputs are committed too, and each foton carries a
commit-pinned `--located` permalink to them, so anyone can fetch and re-hash the exact bytes.

**Aggregator = this repo.** `mirror_once.py`, per registered participant:
1. *Anything new?* — ask GitHub for the latest commit touching `registry/`; unchanged -> skip (one API call).
2. *Fetch* only the new object files (raw URLs by hash) + the participant's `.pub` keys.
3. *Verify* each record's Ed25519 signature with `bin/plankton|nekton verify`; drop anything that fails.
4. *Append* verified records to `mirror/` via `build_mirror.py --add` (append-only, idempotent, ↻N markers).

Append-only + content-addressed => a run with no new work changes nothing. Frequent cron (*/5) is cheap
because step 1 short-circuits; per-participant `interval_minutes` throttles further.

**Trust:** every record is verified on ingest. Admission (the `approved` label) decides *whose records appear
in this federation's view*, not whether they are authentic. The aggregator federates and verifies; never vouches.

**Not here (deliberate):** no server, no consensus, no global ordering. The facts layer is order-independent
and merges conflict-free; completeness is "what participants committed + what this aggregator mirrored".
