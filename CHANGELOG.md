# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-03

### Added
- WCAG 2.2 AA accessibility scanner powered by axe-core and Playwright
- AI-generated accessibility summaries via Claude (Anthropic SDK)
- Automated email discovery and lead enrichment pipeline
- BullMQ worker architecture for scan, enrich, AI, action, and geo jobs
- Express dashboard for lead management at port 3030
- Finnish court case research via Finlex integration
- Dutch court case research via Rechtspraak integration
- IMAP reply monitor for tracking email responses
- GDPR opt-out endpoint for scanned sites
- Public accessibility report pages
- Prisma + SQLite database with full lead lifecycle tracking
- Docker Compose setup for local Redis

[Unreleased]: https://github.com/mikko-lab/a11y-lead-engine/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mikko-lab/a11y-lead-engine/releases/tag/v1.0.0
