#!/usr/bin/env python3
"""register.py - append a participant from an APPROVED registration issue to participants.json.

Reads the issue body (GitHub issue-form markdown: '### Label\\n\\n<value>') from $ISSUE_BODY and the
issue number from $ISSUE_NUMBER. Idempotent: re-approving updates the existing entry (keyed by repo).
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARTICIPANTS = os.path.join(ROOT, "participants.json")
INTERVALS = {"Every 15 minutes": 15, "Every hour": 60, "Every 6 hours": 360, "Every 24 hours": 1440}

def field(body, label):
    m = re.search(r"###\s*" + re.escape(label) + r"\s*\n+(.+?)(?:\n###|\Z)", body, re.S)
    return m.group(1).strip() if m else ""

def main():
    body = os.environ.get("ISSUE_BODY", "")
    name = field(body, "Participant name")
    repo = field(body, "Repository (owner/repo)")
    interval = INTERVALS.get(field(body, "Mirror interval"), 60)
    if not name or not re.match(r"^[\w.-]+/[\w.-]+$", repo):
        print(f"invalid registration: name={name!r} repo={repo!r}", file=sys.stderr)
        sys.exit(1)
    parts = json.load(open(PARTICIPANTS))
    parts = [p for p in parts if p.get("repo") != repo]  # replace any existing entry for this repo
    parts.append({"name": name, "repo": repo, "branch": "main",
                  "interval_minutes": interval, "active": True})
    json.dump(parts, open(PARTICIPANTS, "w"), indent=2)
    print(f"registered {name} ({repo}) every {interval}m")

if __name__ == "__main__":
    main()
