"""Deterministic structured-field extraction from resume text.

This service is intentionally heuristic, not LLM-driven. It reads the raw text
and section breakdown produced by `resume_parser.parse_resume_file` and emits
a small, well-typed payload (skills, years_of_experience, education,
certifications, previous_titles, normalized_keywords) that the ATS matching
service can compare against a normalized job description.

Design notes:
- Skill detection is dictionary-driven. We seed a baseline catalogue and
  union it with skills that already exist on `JobSkill` rows in the database
  so the extractor stays in sync with what jobs actually require.
- Confidence is a coverage score (how many of the requested structured
  fields we managed to populate). It is multiplied into the per-pair
  match confidence later in the matching service.
- Nothing in this module touches the database directly. Pass `known_skills`
  in from the caller so this service is unit-testable.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Iterable

from app.services.jd_normalization_service import JDNormalizationService
from app.services.resume_parser import ParsedResume
from app.services.resume_skill_text import (
    normalize_resume_text_for_skill_matching,
    tokenize_skill_section_lines,
)

logger = logging.getLogger(__name__)


# Baseline skills catalogue. Kept short on purpose — DB-driven JobSkill rows
# extend this set at runtime so we don't have to maintain a giant list here.
BASELINE_SKILLS: tuple[str, ...] = (
    # Languages
    "python", "java", "javascript", "typescript", "go", "golang", "ruby",
    "kotlin", "swift", "scala", "rust", "c", "c++", "c#", "php", "r",
    # Web frameworks / runtimes
    "fastapi", "django", "flask", "spring", "spring boot", "node.js", "node",
    "express", "nestjs", "next.js", "nextjs", "react", "react native",
    "angular", "vue", "vue.js", "svelte", "rails", "laravel", "redux",
    "redux toolkit", "remix", "gatsby", "nuxt",
    # Data / DB
    "postgresql", "postgres", "mysql", "mariadb", "sqlite", "mongodb",
    "redis", "elasticsearch", "cassandra", "dynamodb", "bigquery", "snowflake",
    "sql", "nosql", "kafka", "rabbitmq",
    "prisma", "drizzle", "typeorm", "sequelize",
    # Cloud / infra
    "aws", "gcp", "azure", "docker", "kubernetes", "k8s", "terraform",
    "ansible", "jenkins", "github actions", "gitlab ci", "circleci",
    "cloudflare", "supabase", "firebase", "vercel", "netlify",
    # Data science / ML
    "pandas", "numpy", "scikit-learn", "sklearn", "tensorflow", "pytorch",
    "keras", "spark", "hadoop", "airflow", "dbt", "tableau", "power bi",
    # Testing frameworks — JS
    "jest", "vitest", "mocha", "jasmine", "chai",
    "react testing library", "testing library", "enzyme",
    # Testing frameworks — E2E / integration
    "playwright", "cypress", "selenium", "puppeteer",
    "storybook", "chromatic",
    # Testing concepts
    "unit testing", "integration testing", "e2e testing", "tdd",
    "test-driven development", "test coverage",
    # Web accessibility
    "wcag", "aria", "a11y", "web accessibility", "accessibility",
    "section 508", "wai-aria", "accessibility compliance",
    # CSS tooling & frameworks
    "tailwind", "tailwindcss", "tailwind css",
    "styled-components", "emotion", "css-in-js",
    "material-ui", "mui", "chakra ui", "shadcn", "radix ui",
    "bootstrap", "foundation",
    "sass", "scss", "less",
    # HTML / CSS fundamentals (resume-listed)
    "html", "html5", "css", "css3", "svg",
    # Responsive / mobile
    "responsive design", "responsive web design", "mobile-first",
    "adaptive design", "cross-browser compatibility",
    # Build tools / bundlers
    "webpack", "vite", "rollup", "parcel", "esbuild", "turbopack", "babel",
    # Code quality tools
    "eslint", "prettier", "biome", "sonarqube",
    # State management
    "zustand", "mobx", "recoil", "jotai", "xstate", "context api",
    # React ecosystem
    "react router", "react hook form", "react query", "swr",
    "tanstack query", "tanstack", "framer motion", "axios",
    # Schema / validation
    "zod", "yup", "joi",
    # Design tools
    "figma", "sketch", "adobe xd", "invision", "zeplin",
    # Version control & collaboration
    "git", "github", "gitlab", "bitbucket",
    # API / protocol
    "graphql", "rest", "grpc", "openapi", "trpc", "websockets",
    # Other tooling / observability
    "linux", "bash", "nginx", "prometheus", "grafana", "datadog",
    "celery", "opentelemetry",
    # Methodologies / soft-skill indicators
    "agile", "scrum", "kanban", "jira", "confluence",
    "code review", "pair programming",
    "mentoring", "mentorship", "coaching",
    "technical writing", "documentation",
    "cross-functional", "stakeholder management",
    # Monorepo / packaging
    "turborepo", "nx", "lerna", "pnpm", "yarn",
    "sql server", "opentelemetry",
)

_DEGREE_KEYWORDS: tuple[str, ...] = (
    "phd", "ph.d", "doctorate",
    "mba", "m.b.a",
    "msc", "m.sc", "m.s.", "ms ", "master", "masters",
    "btech", "b.tech", "bsc", "b.sc", "bs ", "b.s.", "bachelor", "bachelors",
    "diploma", "associate degree",
)

_TITLE_HINTS: tuple[str, ...] = (
    "engineer", "developer", "scientist", "analyst", "architect",
    "manager", "consultant", "designer", "lead", "principal",
    "intern", "trainee", "specialist", "coordinator",
)

_DATE_RANGE_RE = re.compile(
    r"(?P<start_month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)?\s*"
    r"(?P<start_year>(?:19|20)\d{2})\s*[-–to]+\s*"
    r"(?P<end>present|current|now|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)?\s*(?:19|20)\d{2})",
    re.IGNORECASE,
)

_EXPLICIT_YEARS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s*(?:of)?\s*(?:experience)?", re.IGNORECASE)


@dataclass(slots=True)
class ExtractedCandidateProfile:
    """Structured fields extracted from a resume.

    `confidence` is a coarse coverage score in [0, 1] used downstream by the
    matching service to dampen scores when extraction was thin.
    """

    skills: list[str] = field(default_factory=list)
    ecosystem_tags: list[str] = field(default_factory=list)
    years_of_experience: float | None = None
    education: list[str] = field(default_factory=list)
    certifications: list[str] = field(default_factory=list)
    previous_titles: list[str] = field(default_factory=list)
    normalized_keywords: list[str] = field(default_factory=list)
    confidence: float = 0.0


# Rule-based ecosystem tags for recruiter insights + semantic ATS payloads.
_ECOSYSTEM_TRIGGERS: tuple[tuple[frozenset[str], str], ...] = (
    (frozenset({"nestjs", "express", "node.js", "javascript", "typescript"}), "node-ecosystem"),
    (frozenset({"react", "next.js", "redux", "angular", "vue", "svelte"}), "frontend-modern"),
    (frozenset({"kafka", "rabbitmq", "activemq"}), "event-driven"),
    (frozenset({"terraform", "ansible", "pulumi"}), "infrastructure-as-code"),
    (frozenset({"docker", "kubernetes", "k8s"}), "containers-orchestration"),
    (frozenset({"prometheus", "grafana", "datadog", "opentelemetry"}), "observability"),
    (frozenset({"postgresql", "mysql", "mongodb", "redis", "cassandra", "dynamodb"}), "data-stores"),
    (frozenset({"aws", "azure", "google cloud", "gcp"}), "cloud-platforms"),
    (frozenset({"jest", "vitest", "cypress", "playwright", "react testing library"}), "testing-practices"),
    (frozenset({"wcag", "aria", "web accessibility", "a11y"}), "accessibility-first"),
    (frozenset({"tailwind", "styled-components", "material-ui", "sass"}), "modern-css"),
)


class ATSExtractionService:
    """Deterministic resume-to-structured-fields extractor."""

    def __init__(self, known_skills: Iterable[str] | None = None) -> None:
        # Normalize once. The baseline + caller-supplied list is unioned and
        # lower-cased so matching is case-insensitive.
        skills = set(BASELINE_SKILLS)
        if known_skills:
            skills.update(s.strip().lower() for s in known_skills if s and s.strip())
        # Sort by length desc so multi-word skills win over their substrings
        # (e.g. "spring boot" matches before "spring").
        self._skills_index: list[str] = sorted(skills, key=lambda s: (-len(s), s))
        self._norm = JDNormalizationService()
        self._canonical_skill_set: set[str] = set()
        for s in self._skills_index:
            cn = self._norm.normalize_skill(s)
            if cn:
                self._canonical_skill_set.add(cn)

    def extract(self, parsed: ParsedResume) -> ExtractedCandidateProfile:
        text_lower = parsed.text.lower()
        skills_section_raw = parsed.sections.get("skills", "")
        experience_section = parsed.sections.get("experience", "")
        education_section = parsed.sections.get("education", "")
        certifications_section = parsed.sections.get("certifications", "")

        skills_norm = self._extract_skills(
            text_lower=text_lower,
            skills_section_lower=skills_section_raw.lower(),
            skills_section_original=skills_section_raw,
        )
        ecosystem_tags = self._infer_ecosystem_tags(skills_norm)
        years = self._extract_years(text=parsed.text, experience_section=experience_section)
        education = self._extract_education(education_section or parsed.text)
        certifications = self._extract_certifications(certifications_section or parsed.text)
        titles = self._extract_titles(experience_section or parsed.text)
        keywords = self._normalize_keywords(skills_norm, titles)

        confidence = self._coverage_confidence(
            skills=skills_norm,
            years=years,
            education=education,
            certifications=certifications,
            titles=titles,
            parser=parsed.parser,
        )
        return ExtractedCandidateProfile(
            skills=skills_norm,
            ecosystem_tags=ecosystem_tags,
            years_of_experience=years,
            education=education,
            certifications=certifications,
            previous_titles=titles,
            normalized_keywords=keywords,
            confidence=confidence,
        )

    @staticmethod
    def _infer_ecosystem_tags(normalized_skills: list[str]) -> list[str]:
        skill_set = set(normalized_skills)
        tags: list[str] = []
        seen: set[str] = set()
        for triggers, tag in _ECOSYSTEM_TRIGGERS:
            if skill_set & triggers and tag not in seen:
                tags.append(tag)
                seen.add(tag)
        return tags

    def _extract_skills(
        self,
        *,
        text_lower: str,
        skills_section_lower: str,
        skills_section_original: str,
    ) -> list[str]:
        """Dictionary scan over alias-normalized text plus tokenized skill lines."""
        scan_full = normalize_resume_text_for_skill_matching(text_lower)
        scan_skills = (
            normalize_resume_text_for_skill_matching(skills_section_lower) if skills_section_lower.strip() else ""
        )
        blob = scan_full
        if scan_skills.strip():
            blob = scan_skills + "\n" + scan_full

        found: list[str] = []
        seen: set[str] = set()

        for skill in self._skills_index:
            ns = self._norm.normalize_skill(skill)
            if not ns or ns in seen:
                continue
            pattern = rf"(?<![a-z0-9+#]){re.escape(skill)}(?![a-z0-9+#])"
            if re.search(pattern, blob):
                seen.add(ns)
                found.append(ns)

        if skills_section_original.strip():
            for tok in tokenize_skill_section_lines(skills_section_original):
                nt = self._norm.normalize_skill(tok)
                if nt and nt in self._canonical_skill_set and nt not in seen:
                    seen.add(nt)
                    found.append(nt)

        return found

    def _extract_years(self, *, text: str, experience_section: str) -> float | None:
        # Path 1: explicit "5+ years of experience" style claims anywhere in resume.
        for match in _EXPLICIT_YEARS_RE.finditer(text):
            try:
                value = float(match.group(1))
                if 0 < value <= 60:
                    return round(value, 1)
            except ValueError:
                continue

        # Path 2: aggregate date ranges in the experience section.
        target = experience_section or text
        total_months = 0
        any_match = False
        for match in _DATE_RANGE_RE.finditer(target):
            any_match = True
            start = self._parse_year(match.group("start_year"))
            end_raw = (match.group("end") or "").strip().lower()
            if end_raw in {"present", "current", "now"}:
                end = self._current_year()
            else:
                end = self._parse_year(end_raw[-4:])
            if start is None or end is None:
                continue
            if end < start:
                continue
            total_months += (end - start) * 12
        if any_match and total_months > 0:
            return round(total_months / 12.0, 1)
        return None

    @staticmethod
    def _parse_year(raw: str | None) -> int | None:
        if not raw:
            return None
        match = re.search(r"(19|20)\d{2}", raw)
        if match is None:
            return None
        try:
            return int(match.group(0))
        except ValueError:
            return None

    @staticmethod
    def _current_year() -> int:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).year

    @staticmethod
    def _extract_education(section_text: str) -> list[str]:
        if not section_text:
            return []
        # Pull lines that look like degree statements. We keep entire lines
        # because resumes often combine degree + institution on one line.
        results: list[str] = []
        seen: set[str] = set()
        for line in section_text.splitlines():
            line_stripped = line.strip()
            if not line_stripped:
                continue
            line_lower = line_stripped.lower()
            if any(keyword in line_lower for keyword in _DEGREE_KEYWORDS):
                key = line_stripped[:160]
                if key not in seen:
                    seen.add(key)
                    results.append(key)
        return results[:6]

    @staticmethod
    def _extract_certifications(section_text: str) -> list[str]:
        if not section_text:
            return []
        results: list[str] = []
        seen: set[str] = set()
        for raw_line in section_text.splitlines():
            line = raw_line.strip(" -•*\t")
            if not line:
                continue
            # Filter out boilerplate "Certifications" header lines that
            # leaked through if section detection picked them up.
            if line.lower().startswith(("certification", "certificate", "license")):
                continue
            if len(line) > 200:
                continue
            if line.lower() not in seen:
                seen.add(line.lower())
                results.append(line)
        return results[:10]

    @staticmethod
    def _extract_titles(section_text: str) -> list[str]:
        if not section_text:
            return []
        titles: list[str] = []
        seen: set[str] = set()
        for raw_line in section_text.splitlines():
            line = raw_line.strip(" -•*\t")
            if not line or len(line) > 120:
                continue
            line_lower = line.lower()
            if any(hint in line_lower for hint in _TITLE_HINTS):
                # Strip company suffixes like "Senior Engineer at Acme" so
                # the comparator focuses on the role name.
                cleaned = re.split(r"\s+(?:at|@|,|\u2013|\u2014|-)\s+", line, maxsplit=1)[0].strip()
                key = cleaned.lower()
                if key not in seen:
                    seen.add(key)
                    titles.append(cleaned)
        return titles[:8]

    @staticmethod
    def _normalize_keywords(skills: list[str], titles: list[str]) -> list[str]:
        seen: set[str] = set()
        keywords: list[str] = []
        for token in (*skills, *titles):
            normalized = token.strip().lower()
            if normalized and normalized not in seen:
                seen.add(normalized)
                keywords.append(normalized)
        return keywords

    @staticmethod
    def _coverage_confidence(
        *,
        skills: list[str],
        years: float | None,
        education: list[str],
        certifications: list[str],
        titles: list[str],
        parser: str,
    ) -> float:
        # Coverage-based confidence: each populated field contributes a fixed
        # weight. Parser quality adjusts the base — pdfplumber is high
        # confidence, plaintext fallback is low.
        weights = {
            "skills": 0.30 if skills else 0.0,
            "years": 0.20 if years is not None else 0.0,
            "education": 0.15 if education else 0.0,
            "certifications": 0.10 if certifications else 0.0,
            "titles": 0.20 if titles else 0.0,
        }
        parser_penalty = {
            "pdfplumber": 1.0,
            "pymupdf": 0.95,
            "python-docx": 1.0,
            "pypdf": 0.9,
            "plaintext": 0.7,
            "unknown": 0.5,
            "none": 0.3,
        }.get(parser, 0.7)
        score = sum(weights.values()) * parser_penalty
        # Always clamp to [0, 1] in case future weights drift.
        return round(max(0.0, min(1.0, score)), 3)
