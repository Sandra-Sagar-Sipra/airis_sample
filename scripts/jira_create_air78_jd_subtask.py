#!/usr/bin/env python3
"""Create JD fallback subtask under AIR-78."""
from __future__ import annotations

import base64
import json
import urllib.request
from pathlib import Path


def load_env() -> dict[str, str]:
    p = Path(__file__).resolve().parents[1] / "backend" / ".env"
    out: dict[str, str] = {}
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("JIRA_") and "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out


def _subtask_type_id(base: str, auth: str) -> str:
    url = f"{base}/rest/api/3/issue/createmeta?projectKeys=AIR&issuetypeNames=Subtask&expand=projects.issuetypes"
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
    with urllib.request.urlopen(req) as resp:
        meta = json.loads(resp.read().decode())
    types = meta["projects"][0]["issuetypes"]
    if not types:
        url2 = f"{base}/rest/api/3/issue/createmeta?projectKeys=AIR&expand=projects.issuetypes"
        req2 = urllib.request.Request(url2, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
        with urllib.request.urlopen(req2) as resp2:
            meta = json.loads(resp2.read().decode())
        for t in meta["projects"][0]["issuetypes"]:
            if "sub" in t["name"].lower():
                return t["id"]
        raise SystemExit("No subtask type found")
    return types[0]["id"]


def main() -> None:
    env = load_env()
    email = env.get("JIRA_AUTH_EMAIL") or env["JIRA_EMAIL"]
    token = env["JIRA_API_TOKEN"]
    base = env["JIRA_BASE_URL"].rstrip("/")
    auth = base64.b64encode(f"{email}:{token}".encode()).decode()
    subtask_id = _subtask_type_id(base, auth)

    body = {
        "fields": {
            "project": {"key": "AIR"},
            "parent": {"key": "AIR-78"},
            "summary": "JD parse: backup API when Groq fails",
            "issuetype": {"id": subtask_id},
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "POST /jobs/parse-jd uses shared llm_json_completion (Groq -> GROQ_ATS -> Grok).",
                            }
                        ],
                    }
                ],
            },
        }
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/rest/api/3/issue",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Basic {auth}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read().decode())
            print(f"Created: {result['key']}")
    except urllib.error.HTTPError as e:
        print(e.read().decode()[:500])


if __name__ == "__main__":
    main()
