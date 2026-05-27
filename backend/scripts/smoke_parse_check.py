#!/usr/bin/env python3
"""Quick smoke check: primary Groq + backup config for resume/JD parse."""
from __future__ import annotations

import sys
from pathlib import Path

# backend root on path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.services.llm_json_completion import (
    LlmJsonCompletionError,
    build_parse_providers,
    complete_json_sync,
)


def main() -> int:
    s = get_settings()
    providers = build_parse_providers(s)
    print("=== AIRIS parse smoke check ===")
    print(f"AI_PARSE_ENABLE_BACKUP: {s.ai_parse_enable_backup}")
    print(f"Providers configured: {[p.label for p in providers]}")
    print(f"Primary Groq key set: {bool(s.groq_api_key)}")
    print(f"Backup Groq key set: {bool(s.groq_api_key_backup)}")

    if not providers:
        print("FAIL: No LLM keys configured.")
        return 1

    prompt = (
        'Return ONLY JSON: {"parsed_resume_data":{"first_name":"Smoke","last_name":"Test"},'
        '"extracted_skills":[{"name":"Python"}],"parse_confidence":0.95}'
    )
    try:
        payload, tag = complete_json_sync(prompt, settings=s)
        name = (payload.get("parsed_resume_data") or {}).get("first_name")
        print(f"PASS: Primary parse OK (provider={tag}, first_name={name})")
    except LlmJsonCompletionError as e:
        print(f"FAIL: LLM parse failed — {e}")
        return 1

    # Backup path: invalid primary, valid backup
    if s.groq_api_key_backup and s.ai_parse_enable_backup:
        bad_primary = s.model_copy(update={"groq_api_key": "INVALID_TEST_KEY_DO_NOT_USE"})
        try:
            _, tag2 = complete_json_sync(prompt, settings=bad_primary)
            if "backup" in tag2:
                print(f"PASS: Backup fallback OK (provider={tag2})")
            else:
                print(f"WARN: Fallback ran but tag={tag2}")
        except LlmJsonCompletionError as e:
            print(f"FAIL: Backup fallback did not work — {e}")
            return 1
    else:
        print("SKIP: Backup fallback (no GROQ_API_KEY_BACKUP or backup disabled)")

    print("=== All smoke checks passed ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
