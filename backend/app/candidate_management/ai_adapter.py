from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import json
import os

from app.core.config import get_settings
from app.candidate_management.schemas import CandidateSkillInput, ResumeParseResult
from app.services.llm_json_completion import LlmJsonCompletionError, complete_json_sync


class HttpAIService:
    """HTTP adapter to external ai-services module."""

    def __init__(self) -> None:
        self.base_url = os.getenv("AI_SERVICES_URL", "").rstrip("/")
        self.timeout_seconds = float(os.getenv("AI_SERVICES_TIMEOUT_SECONDS", "30"))

    def _require_base_url(self) -> str:
        if not self.base_url:
            raise RuntimeError("AI_SERVICES_URL is not configured.")
        return self.base_url

    def parse_resume(self, *, resume_s3_key: str) -> ResumeParseResult:
        settings = get_settings()
        if self.base_url:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                response = client.post(
                    f"{self.base_url}/parse-resume",
                    json={"resume_s3_key": resume_s3_key},
                )
                response.raise_for_status()
                payload = response.json()
        elif settings.groq_api_key:
            payload = self._parse_with_groq(resume_s3_key)
        else:
            payload = self._local_parse_payload(resume_s3_key)
        extracted_skills = [
            CandidateSkillInput(
                name=str(skill.get("name", "")),
                proficiency=skill.get("proficiency"),
                years_experience=skill.get("years_experience"),
                confidence=skill.get("confidence"),
                source=skill.get("source"),
            )
            for skill in payload.get("extracted_skills", [])
            if isinstance(skill, dict) and skill.get("name")
        ]
        return ResumeParseResult(
            parsed_resume_data=payload.get("parsed_resume_data", {}),
            parse_confidence=payload.get("parse_confidence"),
            ai_parse_version=payload.get("ai_parse_version"),
            extracted_skills=extracted_skills,
        )

    def _parse_with_groq(self, resume_s3_key: str) -> dict:
        """Parse resume text using Groq AI for high-quality extraction."""
        storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
        file_path = storage_root / resume_s3_key.replace("/", "_")
        text = self._extract_text(file_path)
        if not text:
             return self._local_parse_payload(resume_s3_key)

        settings = get_settings()
        prompt = f"""Extract candidate details from this resume text.
Return ONLY valid JSON with these exact fields:
{{
  "parsed_resume_data": {{
    "first_name": string or null,
    "last_name": string or null,
    "email": string or null,
    "phone": string or null,
    "location": string or null,
    "headline": string or null,
    "years_experience": integer or null,
    "summary": string or null
  }},
  "extracted_skills": [
    {{"name": string, "proficiency": string or null, "years_experience": float or null}}
  ],
  "parse_confidence": float (0.0 to 1.0)
}}
No explanation. Only JSON.

RESUME TEXT:
{text}"""

        try:
            payload, version_tag = complete_json_sync(prompt, settings=settings)
            payload["ai_parse_version"] = version_tag
            if "extracted_skills" in payload:
                for skill in payload["extracted_skills"]:
                    if skill.get("years_experience") is not None:
                        try:
                            skill["years_experience"] = int(float(skill["years_experience"]))
                        except (ValueError, TypeError):
                            skill["years_experience"] = None
            return payload
        except LlmJsonCompletionError as e:
            import logging

            logging.getLogger(__name__).error("LLM resume parsing failed: %s", e)
            return self._local_parse_payload(resume_s3_key)
        except Exception as e:
            import logging

            logging.getLogger(__name__).error("Resume parsing failed: %s", e)
            return self._local_parse_payload(resume_s3_key)

    def _local_parse_payload(self, resume_s3_key: str) -> dict:
        # Local fallback parser to keep upload flow functional without external ai-services.
        import re
        storage_root = Path(os.getenv("CANDIDATE_RESUME_UPLOAD_DIR", "tmp/candidate-resumes"))
        file_path = storage_root / resume_s3_key.replace("/", "_")
        text = self._extract_text(file_path)
        email_match = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text)
        phone_match = re.search(r"(\+?\d[\d\-\s]{8,}\d)", text)
        years_match = re.search(r"(\d+)\+?\s*(?:years|yrs)", text, flags=re.IGNORECASE)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        full_name = lines[0] if lines else "Unknown Candidate"
        parts = full_name.split()
        first_name = parts[0] if parts else "Unknown"
        last_name = " ".join(parts[1:]) if len(parts) > 1 else "Candidate"
        return {
            "parsed_resume_data": {
                "full_name": full_name,
                "first_name": first_name,
                "last_name": last_name,
                "email": email_match.group(0).lower() if email_match else None,
                "phone": phone_match.group(1).strip() if phone_match else None,
                "location": self._extract_location(text),
                "headline": self._extract_headline(text),
                "summary": text[:1000] if text else None,
                "years_experience": int(years_match.group(1)) if years_match else None,
            },
            "parse_confidence": 0.62,
            "ai_parse_version": "local-fallback-v1",
            "extracted_skills": [{"name": s, "source": "parsed"} for s in self._extract_skills(text)],
        }

    @staticmethod
    def _extract_text(file_path: Path) -> str:
        if not file_path.exists():
            return ""
        suffix = file_path.suffix.lower()
        if suffix == ".pdf":
            try:
                from pypdf import PdfReader

                reader = PdfReader(str(file_path))
                return "\n".join([(page.extract_text() or "") for page in reader.pages]).strip()
            except Exception:
                return ""
        if suffix == ".docx":
            try:
                from docx import Document

                doc = Document(str(file_path))
                return "\n".join([p.text for p in doc.paragraphs]).strip()
            except Exception:
                return ""
        try:
            return file_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            return ""

    @staticmethod
    def _extract_location(text: str) -> str | None:
        common = ["bangalore", "bengaluru", "chennai", "hyderabad", "mumbai", "delhi", "pune"]
        text_l = text.lower()
        for city in common:
            if city in text_l:
                return city.title()
        return None

    @staticmethod
    def _extract_headline(text: str) -> str | None:
        patterns = ["engineer", "developer", "architect", "manager", "analyst", "scientist"]
        text_l = text.lower()
        for role in patterns:
            if role in text_l:
                return role.title()
        return None

    @staticmethod
    def _extract_skills(text: str) -> list[str]:
        known = ["python", "fastapi", "postgresql", "sql", "redis", "aws", "docker", "react", "javascript"]
        text_l = text.lower()
        return [skill.title() for skill in known if skill in text_l]

    def smart_search(self, *, query: str, org_id: UUID, workspace_id: UUID, limit: int) -> list[UUID]:
        base_url = self._require_base_url()
        with httpx.Client(timeout=self.timeout_seconds) as client:
            response = client.post(
                f"{base_url}/smart-search",
                json={
                    "query": query,
                    "org_id": str(org_id),
                    "workspace_id": str(workspace_id),
                    "limit": limit,
                },
            )
            response.raise_for_status()
            payload = response.json()
        ids: list[UUID] = []
        for raw in payload.get("candidate_ids", []):
            try:
                ids.append(UUID(str(raw)))
            except ValueError:
                continue
        return ids

