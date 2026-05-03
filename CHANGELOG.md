# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-03

### Added
- GitHub Actions CI workflow — TypeScript typecheck on every push and PR
- CONTRIBUTING.md with setup instructions and commit style guide
- `typecheck` script (`tsc --noEmit`) to package.json

## [0.5.0] - 2026-04-27

### Added
- SECURITY.md — server configuration, deployment rules, incident history

### Fixed
- Dashboard now listens only on `127.0.0.1:3030` (no public exposure)
- Basic-auth on all `/api/*` routes + async SSRF guard with DNS rebinding check
- Redis bound to localhost and password-protected
- Deploy script uses non-root user (`a11y`) instead of root
- Added `REDIS_PASSWORD`, `DASH_USER`, `DASH_PASS` to `.env.example`

## [0.4.0] - 2026-04-19

### Added
- GEO Agent tab in dashboard — publish AI-generated content to WordPress
- GEO snippet automatically embedded in outgoing emails
- Pre-publish backup and rollback for GEO agent edits
- Protected slug list to prevent overwriting critical pages

### Fixed
- XSS, JSON parsing, GDPR opt-out logging, and dead code issues
- Email schedule limited to weekday mornings

## [0.3.0] - 2026-04-08

### Added
- **Finlex integration** — scrapes Finnish accessibility court cases
- **Rechtspraak.nl integration** — scrapes Dutch accessibility court cases
- **Vroegsignaal** — pre-lawsuit detection via `toegankelijkheidsverklaring.nl`
- **Kanteet tab** in dashboard — court leads with AI-generated tickets
- Court-ticket agent: 4-stage deterministic pipeline (extract → classify → reason → score)
- AI scoring stage 4 with guardrails (`no_org`, `low_confidence`, `not_accessibility`)
- Pipeline stages 2+3: classifier signals + `pain_level` / `urgency` / `why_now` fields
- Scoring agent — Claude evaluates lead priority with risk→revenue mapping

### Fixed
- Finlex parser limited to individual case pages (no navigation link noise)
- Removed overly broad `toegankelijkheid` search term — focus on digital accessibility
- Server IP hidden behind `DEPLOY_SERVER` env variable

## [0.2.0] - 2026-04-07

### Added
- **Distributed worker pipeline** — separate `scan`, `enrich`, `ai`, `action` workers via BullMQ
- `Lead.status` field with full lifecycle tracking
- **Scheduler** — automatic nightly discovery + ENRICHED retry queue
- **Reply detection** — IMAP polling, `REPLIED` status, badge in dashboard
- **Email open tracking** — pixel tracker + open counter in leads table
- **Blocklist management** — add/remove domains from dashboard UI
- Manual email add and edit from dashboard
- Status filter on leads tab
- Multi-select and bulk delete for leads

### Fixed
- URL normalization to prevent duplicate leads
- `sendEmail` flag respected throughout pipeline
- Email open counter display in leads table

## [0.1.0] - 2026-03-31

### Added
- **WCAG 2.2 AA scanner** — axe-core + Playwright, multi-page scan with `homepage+1` depth
- Violations table with conversion tracking and benchmark comparison
- AI-generated accessibility summary via Claude (Anthropic SDK)
- Automated email discovery and lead enrichment
- PDF report generation with lead details
- Express dashboard (port 3030) with lead management
- Manual URL scan with duplicate filtering
- Notes feature per lead
- Filter for perfect-score (100pt) leads
- Browser pool for parallel scanning
- Rate limiting and parallel enrichment
- Playwright memory leak protection
- Docker Compose setup for local Redis
- Deploy script (`deploy.sh`)

### Fixed
- Lead numbering uses `MAX(leadNo)+1` instead of `count()` to avoid collisions
- AI summary heading word-wrap in mobile email clients
- `scans` table ordered by `scannedAt`
- `.env` not overwritten on re-deploy

[Unreleased]: https://github.com/mikko-lab/a11y-lead-engine/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mikko-lab/a11y-lead-engine/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/mikko-lab/a11y-lead-engine/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mikko-lab/a11y-lead-engine/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mikko-lab/a11y-lead-engine/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mikko-lab/a11y-lead-engine/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mikko-lab/a11y-lead-engine/releases/tag/v0.1.0
