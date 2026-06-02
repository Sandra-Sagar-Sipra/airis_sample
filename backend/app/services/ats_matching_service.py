"""ATS Matching Service.

Compares one candidate's structured profile against one job's normalized
requirements and produces a deterministic match score breakdown.

Weights (v2):
- Required skills:   35%
- Preferred skills:  15%
- Experience match:  20%
- Title similarity:  10%
- Education match:    5%
- Communication:      5%
- Culture / practices:5%
- Skill breadth:      5%
                  -------
                   100%

Skill matching uses a tiered cascade:
1. Exact match     → 1.0× credit
2. Synonym match   → 0.8× credit  (same synonym-cluster, e.g. "wcag" ↔ "web accessibility")
3. Category match  → 0.6× credit  (broader category expansion, e.g. "mysql" → "relational databases")
4. No match        → 0.0× credit

Tiers:
- 85+      -> Strong Match
- 70..84   -> Good Match
- 50..69   -> Moderate Match
- <50      -> Weak Match

Output is intentionally serializable (dict-friendly) so the matching service
can be reused by both:
- the live API (`GET /jobs/{id}/matches`) which returns it as JSON, and
- the persistence layer (`candidate_job_matches.matched_skills/missing_skills/
  category_scores`) which stores it as JSONB.

The service is stateless. Pass in pre-loaded structured fields (skills,
years, education, etc.) so this stays unit-testable and so the caller can
batch-load candidates without N+1 DB calls.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Iterable

from app.services.jd_normalization_service import JDNormalizationService

logger = logging.getLogger(__name__)

# ── Synonym groups ─────────────────────────────────────────────────────────────
# Each frozenset is a cluster of equivalent/near-equivalent skills.
# If a JD requires skill A and the candidate has skill B in the same cluster,
# that counts as a synonym match (0.8× credit instead of 1.0× for exact).
_SYNONYM_GROUPS: tuple[frozenset[str], ...] = (
    # Web accessibility standards
    frozenset({"web accessibility", "wcag", "aria", "a11y", "accessibility",
               "section 508", "wai-aria", "accessibility compliance",
               "web accessibility standards", "accessibility compliance standards",
               "accessibility requirements", "ada compliance"}),
    # JavaScript unit / component testing
    frozenset({"jest", "vitest", "mocha", "jasmine", "chai", "unit testing",
               "react testing library", "testing library", "test coverage", "rtl"}),
    # End-to-end / integration testing
    frozenset({"playwright", "cypress", "selenium", "puppeteer",
               "e2e testing", "end-to-end testing", "integration testing"}),
    # Responsive / adaptive UI
    frozenset({"responsive design", "responsive web design", "mobile-first",
               "adaptive design", "responsive ui", "cross-browser compatibility",
               "mobile responsive", "responsive web design principles",
               "responsive design principles", "responsive layouts",
               "responsive web development"}),
    # Tailwind CSS
    frozenset({"tailwind", "tailwindcss", "tailwind css", "utility-first css",
               "modern css frameworks", "css frameworks",
               "modern css frameworks and libraries such as tailwind css",
               "tailwind css framework"}),
    # Bootstrap
    frozenset({"bootstrap", "bootstrap css", "bootstrap framework"}),
    # CSS preprocessors
    frozenset({"sass", "scss", "less", "css preprocessors"}),
    # CSS-in-JS
    frozenset({"styled-components", "css-in-js", "emotion", "stitches"}),
    # Material UI
    frozenset({"material-ui", "mui", "material design", "material ui"}),
    # Headless / utility UI kits
    frozenset({"chakra ui", "chakra", "shadcn", "radix ui", "headless ui"}),
    # State management
    frozenset({"redux", "redux toolkit", "mobx", "zustand", "jotai", "recoil",
               "state management", "flux", "context api", "xstate"}),
    # React ecosystem variants
    frozenset({"react", "react.js", "reactjs"}),
    frozenset({"next.js", "nextjs", "next js"}),
    frozenset({"vue", "vue.js", "vuejs", "vue 3"}),
    frozenset({"angular", "angularjs", "angular.js"}),
    # TypeScript / JavaScript
    frozenset({"typescript", "ts", "typed javascript"}),
    frozenset({"javascript", "js", "es6", "es2015", "es2020", "ecmascript",
               "vanilla javascript", "vanilla js"}),
    # Build tools / bundlers
    frozenset({"webpack", "vite", "parcel", "rollup", "bundler",
               "build tools", "esbuild", "turbopack"}),
    # Code quality / linting
    frozenset({"eslint", "prettier", "linting", "code formatting", "biome"}),
    # Version control
    frozenset({"git", "github", "gitlab", "bitbucket",
               "version control", "source control"}),
    # CI/CD
    frozenset({"ci/cd", "continuous integration", "continuous deployment",
               "continuous delivery", "github actions", "gitlab ci",
               "jenkins", "circleci", "travis ci"}),
    # REST API
    frozenset({"rest", "rest api", "restful", "restful api", "restful services"}),
    # GraphQL
    frozenset({"graphql", "graph api", "apollo graphql", "apollo client"}),
    # Node.js variants
    frozenset({"node.js", "node", "nodejs"}),
    # Web performance
    frozenset({"web performance", "performance optimization", "core web vitals",
               "lighthouse", "page speed"}),
    # HTML
    frozenset({"html", "html5", "markup", "semantic html"}),
    # CSS
    frozenset({"css", "css3", "stylesheets", "cascading style sheets"}),
    # SEO
    frozenset({"seo", "search engine optimization", "meta tags"}),
    # Design tools
    frozenset({"figma", "sketch", "adobe xd", "invision", "zeplin"}),
    # Database synonyms
    frozenset({"postgresql", "postgres", "psql"}),
    frozenset({"mongodb", "mongo", "mongoose"}),
    frozenset({"mysql", "mariadb"}),
    # Cloud
    frozenset({"aws", "amazon web services"}),
    frozenset({"gcp", "google cloud", "google cloud platform"}),
    frozenset({"azure", "microsoft azure"}),
    # HTTP clients / data fetching
    frozenset({"axios", "fetch api", "swr", "react query",
               "tanstack query", "tanstack"}),
    # Form handling
    frozenset({"react hook form", "formik", "form validation"}),
    # Routing
    frozenset({"react router", "react navigation", "client-side routing"}),
    # Schema validation
    frozenset({"zod", "yup", "joi", "schema validation"}),
    # Animation
    frozenset({"framer motion", "gsap", "css animations"}),
    # TDD
    frozenset({"tdd", "test-driven development", "test driven development",
               "bdd", "behavior-driven development"}),
    # Code review
    frozenset({"code review", "pull request review", "pr review", "pair programming"}),
    # Agile practices
    frozenset({"agile", "scrum", "kanban", "sprint",
               "agile methodology", "agile development", "lean"}),
    # Mentoring / leadership
    frozenset({"mentoring", "mentorship", "coaching",
               "technical mentoring", "team leadership", "technical leadership"}),
    # Cross-functional collaboration
    frozenset({"cross-functional", "cross-functional collaboration",
               "stakeholder management", "stakeholder communication"}),
    # ORM / DB access
    frozenset({"prisma", "drizzle", "typeorm", "sequelize", "orm", "sqlalchemy"}),
    # Component documentation
    frozenset({"storybook", "component documentation", "component library"}),
    # Monorepo tooling
    frozenset({"turborepo", "nx", "lerna", "monorepo"}),
)

# Lookup: skill_name → its synonym frozenset.  First group encountered wins.
_SYNONYM_LOOKUP: dict[str, frozenset[str]] = {}
for _grp in _SYNONYM_GROUPS:
    for _sk in _grp:
        if _sk not in _SYNONYM_LOOKUP:
            _SYNONYM_LOOKUP[_sk] = _grp


# Broader category expansions — used as a third-tier fallback after synonym
# matching fails.  A specific candidate skill (e.g. "mysql") expands into
# broader tags (e.g. "relational databases", "sql") so a JD that says
# "relational databases" can still match.
_SKILL_CATEGORY_EXPANSIONS: dict[str, set[str]] = {
    # Databases
    "mysql": {"relational databases", "sql"},
    "postgresql": {"relational databases", "sql"},
    "sql server": {"relational databases", "sql"},
    "sqlite": {"relational databases", "sql"},
    "mongodb": {"nosql databases"},
    "redis": {"nosql databases"},
    "dynamodb": {"nosql databases"},
    "cassandra": {"nosql databases"},
    # APIs
    "rest": {"api design"},
    "graphql": {"api design"},
    # Ecosystems
    "node.js": {"backend", "javascript"},
    "react": {"frontend"},
    "next.js": {"frontend", "react"},
    "vue": {"frontend"},
    "angular": {"frontend"},
    "svelte": {"frontend"},
    # Testing → concepts
    "jest": {"unit testing", "testing"},
    "vitest": {"unit testing", "testing"},
    "cypress": {"e2e testing", "testing"},
    "playwright": {"e2e testing", "testing"},
    "react testing library": {"unit testing", "testing"},
    # Accessibility
    "wcag": {"web accessibility", "accessibility"},
    "aria": {"web accessibility", "accessibility"},
    "a11y": {"web accessibility", "accessibility"},
    # Responsive design
    "responsive design": {"frontend", "mobile"},
    "mobile-first": {"responsive design", "frontend", "mobile"},
    # CSS
    "tailwind": {"css", "styling"},
    "tailwindcss": {"css", "styling"},
    "sass": {"css", "styling"},
    "scss": {"css", "styling"},
    "styled-components": {"css", "styling"},
    "material-ui": {"ui framework", "frontend"},
    "bootstrap": {"css", "ui framework"},
    # TypeScript ⊂ JavaScript
    "typescript": {"javascript"},
    # Agile sub-practices
    "scrum": {"agile"},
    "kanban": {"agile"},
}


# Public so the persistence layer can use the same constants.
WEIGHT_REQUIRED_SKILLS = 35
WEIGHT_PREFERRED_SKILLS = 15
WEIGHT_EXPERIENCE = 20
WEIGHT_TITLE = 10
WEIGHT_EDUCATION = 5
WEIGHT_COMMUNICATION = 5
WEIGHT_CULTURE = 5
WEIGHT_BREADTH = 5
TOTAL_WEIGHT = (
    WEIGHT_REQUIRED_SKILLS
    + WEIGHT_PREFERRED_SKILLS
    + WEIGHT_EXPERIENCE
    + WEIGHT_TITLE
    + WEIGHT_EDUCATION
    + WEIGHT_COMMUNICATION
    + WEIGHT_CULTURE
    + WEIGHT_BREADTH
)
assert TOTAL_WEIGHT == 100, "ATS scoring weights must sum to 100."


# ── Communication & culture indicators ────────────────────────────────────────
# Detected from extracted candidate skills / titles.  Absence is neutral (not
# penalised) because most technical resumes don't explicitly list soft skills.
_COMMUNICATION_INDICATORS: frozenset[str] = frozenset({
    "stakeholder management", "cross-functional", "cross-functional collaboration",
    "client communication", "stakeholder communication", "technical writing",
    "documentation", "presentation", "people management", "team lead",
    "team leadership", "technical leadership", "code review", "pr review",
    "written communication", "verbal communication", "public speaking",
    "confluence", "notion",
})

_CULTURE_INDICATORS: frozenset[str] = frozenset({
    "agile", "scrum", "kanban", "mentoring", "mentorship", "coaching",
    "tdd", "test-driven development", "pair programming", "continuous learning",
    "ownership", "problem solving", "initiative", "self-starter",
    "clean code", "solid principles", "design patterns",
})

# ── Breadth domains ────────────────────────────────────────────────────────────
# One domain fires when the candidate covers ≥ 1 skill from the set.
# Breadth score = covered_domains / total_domains * 100.
_BREADTH_DOMAINS: tuple[tuple[str, frozenset[str]], ...] = (
    ("frontend", frozenset({"react", "next.js", "vue", "angular", "svelte", "remix"})),
    ("backend", frozenset({"node.js", "django", "fastapi", "flask", "spring", "spring boot", "rails", "nestjs", "laravel"})),
    ("databases", frozenset({"postgresql", "mysql", "mongodb", "redis", "sqlite", "elasticsearch", "dynamodb"})),
    ("cloud", frozenset({"aws", "gcp", "azure", "cloudflare", "supabase", "firebase"})),
    ("testing", frozenset({"jest", "vitest", "cypress", "playwright", "react testing library", "testing library"})),
    ("devops", frozenset({"docker", "kubernetes", "terraform", "ansible", "k8s"})),
    ("languages", frozenset({"typescript", "javascript", "python", "java", "go", "rust", "kotlin", "swift"})),
    ("ci_cd", frozenset({"github actions", "jenkins", "gitlab ci", "circleci"})),
    ("css_tooling", frozenset({"tailwind", "styled-components", "material-ui", "bootstrap", "sass", "scss"})),
    ("state_mgmt", frozenset({"redux", "zustand", "mobx", "recoil", "jotai", "redux toolkit"})),
)


# Education ranks. Higher rank = higher degree.
_EDU_LEVELS: tuple[tuple[str, int], ...] = (
    ("phd", 5),
    ("ph.d", 5),
    ("doctorate", 5),
    ("mba", 4),
    ("m.b.a", 4),
    ("master", 4),
    ("msc", 4),
    ("m.sc", 4),
    ("m.s.", 4),
    ("ms ", 4),
    ("bachelor", 3),
    ("btech", 3),
    ("b.tech", 3),
    ("bsc", 3),
    ("b.sc", 3),
    ("b.s.", 3),
    ("diploma", 2),
    ("associate", 2),
    ("high school", 1),
)


@dataclass(slots=True)
class CandidateScoringInput:
    """Pre-loaded candidate fields used for scoring.

    Note: skills are expected pre-normalized (lowercased + alias-mapped via
    `JDNormalizationService.normalize_skill`). The matching service does not
    re-normalize what the caller supplies.
    """

    candidate_id: str
    skills: list[str] = field(default_factory=list)
    years_of_experience: float | None = None
    previous_titles: list[str] = field(default_factory=list)
    education: list[str] = field(default_factory=list)
    parser_confidence: float | None = None  # from extraction service [0..1]


@dataclass(slots=True)
class JobScoringInput:
    """Pre-loaded job fields used for scoring.

    `required_skills_normalized` and `preferred_skills_normalized` come from
    `JDNormalizationService.normalize`. `min_experience_years` is the lower
    bound from the JD; `max_experience_years` is informational only (we don't
    penalize over-qualified candidates here).
    """

    job_id: str
    title: str | None = None
    required_skills_normalized: list[str] = field(default_factory=list)
    preferred_skills_normalized: list[str] = field(default_factory=list)
    min_experience_years: float | None = None
    max_experience_years: float | None = None
    education_requirements: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MatchResult:
    """Deterministic scoring output for a (candidate, job) pair."""

    match_score: int  # 0..100
    matched_skills: list[str] = field(default_factory=list)
    missing_skills: list[str] = field(default_factory=list)
    matched_preferred_skills: list[str] = field(default_factory=list)
    category_scores: dict[str, int] = field(default_factory=dict)
    recommendation: str = "Weak Match"
    confidence_score: float = 0.0
    # v2: debug / transparency fields
    skill_match_log: list[dict[str, str | None]] = field(default_factory=list)
    score_explanation: str = ""

    def to_jsonable(self) -> dict[str, object]:
        """Return a JSON-serializable view safe to drop into JSONB columns."""
        return {
            "match_score": self.match_score,
            "matched_skills": list(self.matched_skills),
            "missing_skills": list(self.missing_skills),
            "matched_preferred_skills": list(self.matched_preferred_skills),
            "category_scores": dict(self.category_scores),
            "recommendation": self.recommendation,
            "confidence_score": float(self.confidence_score),
            "skill_match_log": list(self.skill_match_log),
            "score_explanation": self.score_explanation,
        }


class ATSMatchingService:
    """Deterministic, weighted candidate-job matcher (v2: tiered synonym matching)."""

    def __init__(self) -> None:
        self._normalizer = JDNormalizationService()

    def score(self, *, candidate: CandidateScoringInput, job: JobScoringInput) -> MatchResult:
        # Normalize everything one more time defensively.
        cand_skills: set[str] = {self._normalizer.normalize_skill(s) for s in candidate.skills if s}
        cand_skills.discard("")

        # Expand candidate skills into broader categories ("mysql" → "relational databases")
        # so high-level JDs can still match specific resume skills.
        expanded: set[str] = set(cand_skills)
        for s in list(cand_skills):
            expanded |= _SKILL_CATEGORY_EXPANSIONS.get(s, set())
        cand_skills = expanded

        required = [s for s in (self._normalizer.normalize_skill(x) for x in job.required_skills_normalized) if s]
        preferred = [s for s in (self._normalizer.normalize_skill(x) for x in job.preferred_skills_normalized) if s]

        required_score, matched_required, missing_required, req_log = self._score_required(cand_skills, required)
        preferred_score, matched_preferred, pref_log = self._score_preferred(cand_skills, preferred)
        experience_score = self._score_experience(candidate.years_of_experience, job)
        title_score = self._score_title(candidate.previous_titles, job.title)
        education_score = self._score_education(candidate.education, job.education_requirements)
        communication_score = self._score_communication(candidate)
        culture_score = self._score_culture(candidate)
        breadth_score = self._score_breadth(cand_skills)

        weighted = (
            required_score * WEIGHT_REQUIRED_SKILLS
            + preferred_score * WEIGHT_PREFERRED_SKILLS
            + experience_score * WEIGHT_EXPERIENCE
            + title_score * WEIGHT_TITLE
            + education_score * WEIGHT_EDUCATION
            + communication_score * WEIGHT_COMMUNICATION
            + culture_score * WEIGHT_CULTURE
            + breadth_score * WEIGHT_BREADTH
        ) / 100.0
        match_score = int(round(max(0.0, min(100.0, weighted))))
        recommendation = self._tier_for(match_score)

        confidence_score = self._compute_confidence(
            candidate=candidate,
            job=job,
            required_count=len(required),
            preferred_count=len(preferred),
            matched_required=len(matched_required),
        )

        category_scores: dict[str, int] = {
            "required_skills": int(round(required_score)),
            "preferred_skills": int(round(preferred_score)),
            "experience": int(round(experience_score)),
            "title": int(round(title_score)),
            "education": int(round(education_score)),
            "communication": int(round(communication_score)),
            "culture": int(round(culture_score)),
            "breadth": int(round(breadth_score)),
        }

        skill_match_log = req_log + pref_log
        score_explanation = self._build_explanation(
            category_scores=category_scores,
            match_score=match_score,
        )

        return MatchResult(
            match_score=match_score,
            matched_skills=sorted(matched_required),
            missing_skills=sorted(missing_required),
            matched_preferred_skills=sorted(matched_preferred),
            category_scores=category_scores,
            recommendation=recommendation,
            confidence_score=round(confidence_score, 3),
            skill_match_log=skill_match_log,
            score_explanation=score_explanation,
        )

    # ------------------------------------------------------------------
    # Tiered skill scoring helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _match_skill(jd_skill: str, candidate_skills: set[str]) -> tuple[float, str, str | None]:
        """Return (credit, match_type, matched_candidate_skill) for one JD skill.

        Cascade:
        1.0 = exact match
        0.8 = synonym match  (same synonym cluster)
        0.6 = category match (JD skill is a broader category a cand skill expands to)
        0.7 = substring match (cand skill IS a substring of the verbose JD skill phrase)
        0.65= substring-synonym (a synonym of a cand skill appears in the JD phrase)
        0.0 = missing
        """
        # 1. Exact match
        if jd_skill in candidate_skills:
            return 1.0, "exact", jd_skill

        # 2. Synonym match (same cluster)
        group = _SYNONYM_LOOKUP.get(jd_skill)
        if group:
            for cs in candidate_skills:
                if cs in group:
                    return 0.8, "synonym", cs

        # 3. Category match (JD skill is a broad category that some cand skill expands to)
        for cs in candidate_skills:
            if jd_skill in _SKILL_CATEGORY_EXPANSIONS.get(cs, set()):
                return 0.6, "category", cs

        # 4. Substring / fuzzy match — handles verbose JD skill descriptions like
        #    "modern css frameworks and libraries such as tailwind css" or
        #    "web accessibility standards" where a known skill appears inside the phrase.
        if len(jd_skill) > 15:  # only for long-form JD entries (not short exact names)
            for cs in candidate_skills:
                if len(cs) >= 4 and cs in jd_skill:
                    return 0.7, "substring", cs
            # Check synonyms of candidate skills against the JD phrase
            for cs in candidate_skills:
                cs_group = _SYNONYM_LOOKUP.get(cs)
                if cs_group:
                    for syn in cs_group:
                        if len(syn) >= 6 and syn in jd_skill:
                            return 0.65, "substring_synonym", cs

        return 0.0, "missing", None

    @classmethod
    def _score_required(
        cls, candidate_skills: set[str], required: Iterable[str]
    ) -> tuple[float, list[str], list[str], list[dict[str, str | None]]]:
        """Return (pct_score, matched_jd_skills, missing_jd_skills, match_log)."""
        required_list = list(required)
        if not required_list:
            return 100.0, [], [], []

        total_credit = 0.0
        matched: list[str] = []
        missing: list[str] = []
        log: list[dict[str, str | None]] = []

        for skill in required_list:
            credit, match_type, candidate_skill = cls._match_skill(skill, candidate_skills)
            total_credit += credit
            if match_type != "missing":
                matched.append(skill)
            else:
                missing.append(skill)
            log.append({
                "jd_skill": skill,
                "match_type": match_type,
                "candidate_skill": candidate_skill,
                "section": "required",
            })

        score = (total_credit / len(required_list)) * 100.0
        return score, matched, missing, log

    @classmethod
    def _score_preferred(
        cls, candidate_skills: set[str], preferred: Iterable[str]
    ) -> tuple[float, list[str], list[dict[str, str | None]]]:
        """Return (pct_score, matched_preferred_skills, match_log)."""
        preferred_list = list(preferred)
        if not preferred_list:
            return 100.0, [], []

        total_credit = 0.0
        matched: list[str] = []
        log: list[dict[str, str | None]] = []

        for skill in preferred_list:
            credit, match_type, candidate_skill = cls._match_skill(skill, candidate_skills)
            total_credit += credit
            if match_type != "missing":
                matched.append(skill)
            log.append({
                "jd_skill": skill,
                "match_type": match_type,
                "candidate_skill": candidate_skill,
                "section": "preferred",
            })

        score = (total_credit / len(preferred_list)) * 100.0
        return score, matched, log

    # ------------------------------------------------------------------
    # Scalar sub-scorers (each returns 0..100)
    # ------------------------------------------------------------------

    @staticmethod
    def _score_experience(years: float | None, job: JobScoringInput) -> float:
        if job.min_experience_years is None:
            return 100.0 if years is not None else 70.0
        if years is None:
            return 0.0
        if years >= job.min_experience_years:
            over = years - job.min_experience_years
            return min(100.0, 90.0 + over * 1.0)
        ratio = max(0.0, years / max(job.min_experience_years, 0.1))
        return round(ratio * 90.0, 2)

    @classmethod
    def _score_title(cls, previous_titles: Iterable[str], jd_title: str | None) -> float:
        if not jd_title:
            return 100.0
        jd_tokens = cls._title_tokens(jd_title)
        if not jd_tokens:
            return 100.0
        best = 0.0
        for raw_title in previous_titles:
            cand_tokens = cls._title_tokens(raw_title)
            if not cand_tokens:
                continue
            overlap = len(jd_tokens & cand_tokens)
            score = (overlap / len(jd_tokens)) * 100.0
            if score > best:
                best = score
        return best

    @staticmethod
    def _title_tokens(value: str) -> set[str]:
        """Tokenise a job title, stripping seniority words and punctuation.

        Handles parenthetical qualifiers such as "(React / Next.js)" by
        treating slashes and parens as whitespace before tokenising.
        """
        stop = {
            "senior", "sr", "junior", "jr", "lead", "principal", "staff",
            "the", "a", "an", "of", "and", "or",
        }
        # Replace parens, slashes, commas with spaces so "React / Next.js" → tokens.
        cleaned = re.sub(r"[/(),–—]", " ", value.lower())
        tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9+#._-]*", cleaned)
        return {tok for tok in tokens if tok not in stop and len(tok) >= 2}

    @classmethod
    def _score_education(
        cls, candidate_education: Iterable[str], jd_education_requirements: Iterable[str]
    ) -> float:
        jd_rank = max((cls._edu_rank(req) for req in jd_education_requirements), default=0)
        if jd_rank == 0:
            cand_rank = max((cls._edu_rank(line) for line in candidate_education), default=0)
            return 100.0 if cand_rank > 0 else 80.0
        cand_rank = max((cls._edu_rank(line) for line in candidate_education), default=0)
        if cand_rank == 0:
            return 0.0
        if cand_rank >= jd_rank:
            return 100.0
        return max(0.0, 100.0 - (jd_rank - cand_rank) * 25.0)

    @staticmethod
    def _edu_rank(text: str | None) -> int:
        if not text:
            return 0
        text_l = text.lower()
        for keyword, rank in _EDU_LEVELS:
            if keyword in text_l:
                return rank
        return 0

    @staticmethod
    def _score_communication(candidate: CandidateScoringInput) -> float:
        """Detect communication indicators in extracted skills and titles.

        Baseline 60 (neutral — most tech resumes don't list soft skills).
        +10 per detected indicator, capped at 100.
        """
        candidate_tokens: set[str] = set()
        for s in candidate.skills:
            candidate_tokens.add(s.lower())
        for t in candidate.previous_titles:
            candidate_tokens.update(w.lower() for w in t.split())

        hits = sum(1 for ind in _COMMUNICATION_INDICATORS if ind in candidate_tokens or any(ind in tok for tok in candidate_tokens))
        return min(100.0, 60.0 + hits * 10.0)

    @staticmethod
    def _score_culture(candidate: CandidateScoringInput) -> float:
        """Detect culture / professional-practice indicators in skills and titles.

        Baseline 60. +10 per detected indicator, capped at 100.
        """
        candidate_tokens: set[str] = set()
        for s in candidate.skills:
            candidate_tokens.add(s.lower())
        for t in candidate.previous_titles:
            candidate_tokens.update(w.lower() for w in t.split())

        hits = sum(1 for ind in _CULTURE_INDICATORS if ind in candidate_tokens or any(ind in tok for tok in candidate_tokens))
        return min(100.0, 60.0 + hits * 10.0)

    @staticmethod
    def _score_breadth(candidate_skills: set[str]) -> float:
        """How many distinct technical domains the candidate covers.

        Score = (domains covered / total domains defined) × 100.
        A full-stack developer covering all domains gets 100.
        """
        if not _BREADTH_DOMAINS:
            return 70.0
        covered = sum(1 for _, domain_skills in _BREADTH_DOMAINS if candidate_skills & domain_skills)
        return round((covered / len(_BREADTH_DOMAINS)) * 100.0, 2)

    @staticmethod
    def _tier_for(score: int) -> str:
        if score >= 85:
            return "Strong Match"
        if score >= 70:
            return "Good Match"
        if score >= 50:
            return "Moderate Match"
        return "Weak Match"

    @staticmethod
    def _build_explanation(*, category_scores: dict[str, int], match_score: int) -> str:
        """Build a short human-readable score breakdown string."""
        parts = [
            f"Required:{category_scores.get('required_skills', 0)}×{WEIGHT_REQUIRED_SKILLS}%",
            f"Preferred:{category_scores.get('preferred_skills', 0)}×{WEIGHT_PREFERRED_SKILLS}%",
            f"Experience:{category_scores.get('experience', 0)}×{WEIGHT_EXPERIENCE}%",
            f"Title:{category_scores.get('title', 0)}×{WEIGHT_TITLE}%",
            f"Education:{category_scores.get('education', 0)}×{WEIGHT_EDUCATION}%",
            f"Communication:{category_scores.get('communication', 0)}×{WEIGHT_COMMUNICATION}%",
            f"Culture:{category_scores.get('culture', 0)}×{WEIGHT_CULTURE}%",
            f"Breadth:{category_scores.get('breadth', 0)}×{WEIGHT_BREADTH}%",
        ]
        return f"[{' | '.join(parts)}] Total:{match_score}"

    @staticmethod
    def _compute_confidence(
        *,
        candidate: CandidateScoringInput,
        job: JobScoringInput,
        required_count: int,
        preferred_count: int,
        matched_required: int,
    ) -> float:
        """Confidence = (extraction coverage) × (job specificity) × (signal density)."""
        if candidate.parser_confidence is not None:
            coverage = max(0.0, min(1.0, candidate.parser_confidence))
        else:
            populated = sum(
                1
                for v in (
                    candidate.skills,
                    candidate.previous_titles,
                    candidate.education,
                )
                if v
            )
            coverage = populated / 3.0
            if candidate.years_of_experience is not None:
                coverage = min(1.0, coverage + 0.2)

        specificity = 0.6
        if required_count >= 3:
            specificity = 1.0
        elif required_count >= 1:
            specificity = 0.8

        if required_count == 0:
            density = 0.7
        else:
            density = 0.6 + 0.4 * (matched_required / required_count)

        return round(coverage * specificity * density, 3)
