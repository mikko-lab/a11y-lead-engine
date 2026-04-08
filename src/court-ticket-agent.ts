/**
 * Court Ticket Agent — Deterministinen 4-vaiheinen pipeline
 *
 * [CASE INPUT]
 *    ↓
 * (1) ENTITY EXTRACTION     — Claude, konservatiivinen, ei arvauksia
 *    ↓
 * (2) ACCESSIBILITY CLASSIFIER — säännöt, ei LLM
 *    ↓
 * (3) COMMERCIAL REASONING  — Claude, vain relevanteille tapauksille
 *    ↓
 * (4) SCORING FUNCTION      — deterministinen koodi, ei LLM
 */

import Anthropic from '@anthropic-ai/sdk'
import { db } from './db/client'
import { FinlexTapaus } from './discovery/finlex'
import { RechtspraakTapaus } from './discovery/rechtspraak'

type Tapaus = (FinlexTapaus & { source: 'finlex' }) | (RechtspraakTapaus & { source: 'rechtspraak' })

// ── Canonical case format ─────────────────────────────────────────────────────

interface CanonicalCase {
  case_uid: string
  country: string
  court: string | null
  date: string | null
  language: 'fi' | 'nl' | 'en'
  title: string
  summary: string | null
  source: string
}

function toCanonical(tapaus: Tapaus): CanonicalCase {
  if (tapaus.source === 'finlex') {
    return {
      case_uid: tapaus.viite ?? tapaus.url,
      country:  'FI',
      court:    tapaus.tuomioistuin ?? null,
      date:     tapaus.pvm ?? null,
      language: 'fi',
      title:    tapaus.otsikko,
      summary:  tapaus.katkelmia ?? null,
      source:   'finlex',
    }
  }
  return {
    case_uid: tapaus.ecli,
    country:  'NL',
    court:    tapaus.tuomioistuin ?? null,
    date:     tapaus.pvm ?? null,
    language: 'nl',
    title:    tapaus.otsikko,
    summary:  tapaus.tiivistelma ?? null,
    source:   'rechtspraak',
  }
}

// ── Stage 1: Entity Extraction ────────────────────────────────────────────────

interface ExtractedEntities {
  defendant_organization: string | null
  organization_type: 'public' | 'private' | 'unknown'
  country: string | null
  service_type: 'website' | 'mobile_app' | 'physical_service' | 'unknown'
  mentions_digital_service: boolean
  mentions_accessibility: boolean
  mentions_wcag: boolean
}

const ENTITY_SYSTEM = `You are a legal information extraction system.
Extract structured entities from the court decision. Return JSON only.
Rules:
- Do not guess organization names. Use null if uncertain.
- Do not hallucinate WCAG if not explicitly stated.
- mentions_wcag = true ONLY if "WCAG", "EN 301 549", or "webtoegankelijkheid" appears in the text.
- mentions_digital_service = true only for websites, apps, portals, digital services.
- Be conservative. Uncertain → null or false.`

async function extractEntities(
  kase: CanonicalCase,
  client: Anthropic
): Promise<ExtractedEntities | null> {
  const input = [
    `Title: ${kase.title}`,
    kase.court   ? `Court: ${kase.court}` : '',
    kase.date    ? `Date: ${kase.date}` : '',
    kase.summary ? `Text: ${kase.summary}` : '',
  ].filter(Boolean).join('\n')

  const prompt = `Extract entities from this ${kase.language.toUpperCase()} court case:

${input}

Return ONLY this JSON (no explanation):
{
  "defendant_organization": "exact name or null",
  "organization_type": "public | private | unknown",
  "country": "${kase.country}",
  "service_type": "website | mobile_app | physical_service | unknown",
  "mentions_digital_service": false,
  "mentions_accessibility": false,
  "mentions_wcag": false
}`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: ENTITY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return null
    const p = JSON.parse(text.replace(/^```json?\n?/, '').replace(/\n?```$/, ''))
    return {
      defendant_organization: p.defendant_organization ?? null,
      organization_type:      ['public','private','unknown'].includes(p.organization_type) ? p.organization_type : 'unknown',
      country:                p.country ?? kase.country,
      service_type:           ['website','mobile_app','physical_service','unknown'].includes(p.service_type) ? p.service_type : 'unknown',
      mentions_digital_service: Boolean(p.mentions_digital_service),
      mentions_accessibility:   Boolean(p.mentions_accessibility),
      mentions_wcag:            Boolean(p.mentions_wcag),
    }
  } catch {
    return null
  }
}

// ── Stage 2: Accessibility Classifier (LLM, konservatiivinen) ────────────────

interface AccessibilityClassification {
  is_accessibility_case: boolean
  confidence: number
  signals: string[]
}

const CLASSIFIER_SYSTEM = `You are an accessibility legal classifier.
Evaluate if a case relates to digital accessibility (WCAG context).
Rules:
- WCAG mention = strong signal
- Digital service + discrimination = medium signal
- Pure physical accessibility = false
- Be conservative: if unsure → return false with low confidence`

async function classifyAccessibility(
  kase: CanonicalCase,
  entities: ExtractedEntities,
  client: Anthropic
): Promise<AccessibilityClassification> {
  const input = [
    `Title: ${kase.title}`,
    kase.summary ? `Text: ${kase.summary.slice(0, 500)}` : '',
    `WCAG mentioned: ${entities.mentions_wcag}`,
    `Digital service: ${entities.mentions_digital_service}`,
    `Accessibility mentioned: ${entities.mentions_accessibility}`,
    `Service type: ${entities.service_type}`,
  ].filter(Boolean).join('\n')

  const prompt = `Classify this court case:

${input}

Return ONLY JSON:
{
  "is_accessibility_case": false,
  "confidence": 0.0,
  "signals": ["wcag_mentioned", "digital_service", "discrimination_argument", "public_service_context"]
}
Include only signals that actually apply. Empty array if none.`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return { is_accessibility_case: false, confidence: 0, signals: [] }
    const p = JSON.parse(text.replace(/^```json?\n?/, '').replace(/\n?```$/, ''))
    return {
      is_accessibility_case: Boolean(p.is_accessibility_case),
      confidence:            Math.min(1, Math.max(0, Number(p.confidence ?? 0))),
      signals:               Array.isArray(p.signals) ? p.signals : [],
    }
  } catch {
    return { is_accessibility_case: false, confidence: 0, signals: [] }
  }
}

// ── Stage 3: Commercial Reasoning ─────────────────────────────────────────────

interface CommercialReasoning {
  target_organization: string | null
  sector: 'public_authority' | 'private_company' | 'healthcare' | 'education' | 'ngo' | 'unknown'
  pain_level: number   // 0–10
  urgency: number      // 0–10
  suggested_angle: string
  why_now: string
}

const COMMERCIAL_SYSTEM = `You are a B2B sales strategist for a digital accessibility consultancy.
Based on a court case, determine if this creates a sales opportunity.
Rules:
- Focus on business impact, not legal analysis
- Public sector = high urgency (legal obligation)
- Court ruling = higher urgency than complaint
- Suggested angle must be concrete (audit, remediation, compliance plan)
- pain_level and urgency are 0–10 integers`

async function reasonCommercially(
  kase: CanonicalCase,
  entities: ExtractedEntities,
  classification: AccessibilityClassification,
  client: Anthropic
): Promise<CommercialReasoning | null> {
  const prompt = `Sales opportunity analysis:

Organization: ${entities.defendant_organization ?? 'unknown'}
Type: ${entities.organization_type}
Signals: ${classification.signals.join(', ') || 'none'}
Case: ${kase.title}
${kase.summary ? `Context: ${kase.summary.slice(0, 300)}` : ''}

Return ONLY JSON:
{
  "target_organization": "exact name or null",
  "sector": "public_authority | private_company | healthcare | education | ngo | unknown",
  "pain_level": 8,
  "urgency": 9,
  "suggested_angle": "Concrete 1-2 sentences. Mention audit/remediation/compliance. Match language to country (${kase.country}).",
  "why_now": "1 sentence — specific trigger from this case"
}`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: COMMERCIAL_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return null
    const p = JSON.parse(text.replace(/^```json?\n?/, '').replace(/\n?```$/, ''))
    const validSectors = ['public_authority','private_company','healthcare','education','ngo','unknown']
    return {
      target_organization: p.target_organization ?? entities.defendant_organization ?? null,
      sector:              validSectors.includes(p.sector) ? p.sector : 'unknown',
      pain_level:          Math.min(10, Math.max(0, Math.round(Number(p.pain_level ?? 5)))),
      urgency:             Math.min(10, Math.max(0, Math.round(Number(p.urgency ?? 5)))),
      suggested_angle:     String(p.suggested_angle ?? '').slice(0, 500),
      why_now:             String(p.why_now ?? '').slice(0, 300),
    }
  } catch {
    return null
  }
}

// ── Stage 4: Scoring Function (deterministinen koodi) ─────────────────────────

interface Scores {
  accessibilityRisk: number
  salesPriority: number
  confidence: number
  wcagRelevant: boolean
}

function calculateScore(
  entities: ExtractedEntities,
  classification: AccessibilityClassification,
  commercial: CommercialReasoning | null
): Scores {
  if (!classification.is_accessibility_case) {
    return { accessibilityRisk: 0, salesPriority: 0, confidence: classification.confidence, wcagRelevant: false }
  }

  // Accessibility risk — signaaleista
  let risk = 0.2
  if (classification.signals.includes('wcag_mentioned'))          risk += 0.35
  if (classification.signals.includes('digital_service'))         risk += 0.20
  if (classification.signals.includes('discrimination_argument'))  risk += 0.15
  if (classification.signals.includes('public_service_context'))  risk += 0.10
  if (entities.service_type === 'website' || entities.service_type === 'mobile_app') risk += 0.05
  risk = Math.min(1, risk)

  // Sales priority — pain + urgency LLM:ltä, normalisoidaan
  const painNorm    = commercial ? commercial.pain_level / 10 : 0.5
  const urgencyNorm = commercial ? commercial.urgency / 10    : 0.5
  const rawPriority = (painNorm * 0.4 + urgencyNorm * 0.6) * 10
  const salesPriority = Math.min(10, Math.round(rawPriority))

  // Confidence — classifier + organisaation tunnistus
  const orgBonus = entities.defendant_organization ? 0.1 : -0.2
  const confidence = Math.min(1, Math.max(0, classification.confidence + orgBonus))

  return { accessibilityRisk: risk, salesPriority, confidence, wcagRelevant: true }
}

// ── Public interface ──────────────────────────────────────────────────────────

export interface RiskRevenueMapping {
  organization: string | null
  sector: CommercialReasoning['sector']
  accessibilityRisk: number
  salesPriority: number
  confidence: number
  wcagRelevant: boolean
  suggestedAngle: string
  aiSummary: string
}

export async function analysoi(tapaus: Tapaus): Promise<RiskRevenueMapping | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('  [court-ticket-agent] ANTHROPIC_API_KEY puuttuu!')
    return null
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const kase = toCanonical(tapaus)

  // Stage 1
  const entities = await extractEntities(kase, client)
  if (!entities) return null

  // Stage 2
  const classification = await classifyAccessibility(kase, entities, client)

  // Stage 3 — vain relevanteille (säästää API-kutsuja)
  const commercial = classification.is_accessibility_case
    ? await reasonCommercially(kase, entities, classification, client)
    : null

  // Stage 4
  const scores = calculateScore(entities, classification, commercial)

  const whyNow = commercial?.why_now
    ? `${commercial.why_now} | Signals: ${classification.signals.join(', ')}`
    : `Signals: ${classification.signals.join(', ') || 'none'}`

  return {
    organization:      commercial?.target_organization ?? entities.defendant_organization,
    sector:            commercial?.sector ?? 'unknown',
    accessibilityRisk: scores.accessibilityRisk,
    salesPriority:     scores.salesPriority,
    confidence:        scores.confidence,
    wcagRelevant:      scores.wcagRelevant,
    suggestedAngle:    commercial?.suggested_angle ?? '',
    aiSummary:         whyNow,
  }
}

export async function tallennaTiketti(
  tapaus: Tapaus,
  tulos: RiskRevenueMapping,
  maa: string
): Promise<void> {
  const kase = toCanonical(tapaus)

  await db.courtLead.upsert({
    where: { caseRef: kase.case_uid },
    update: {
      orgName:           tulos.organization,
      sector:            tulos.sector,
      accessibilityRisk: tulos.accessibilityRisk,
      salesPriority:     tulos.salesPriority,
      confidence:        tulos.confidence,
      wcagRelevant:      tulos.wcagRelevant,
      suggestedAngle:    tulos.suggestedAngle,
      aiSummary:         tulos.aiSummary,
      priorityScore:     tulos.salesPriority,
      contactAngle:      tulos.suggestedAngle,
    },
    create: {
      source:            tapaus.source,
      caseRef:           kase.case_uid,
      caseUrl:           tapaus.url,
      caseTitle:         kase.title,
      court:             kase.court,
      caseDate:          kase.date,
      country:           maa,
      orgName:           tulos.organization,
      sector:            tulos.sector,
      accessibilityRisk: tulos.accessibilityRisk,
      salesPriority:     tulos.salesPriority,
      confidence:        tulos.confidence,
      wcagRelevant:      tulos.wcagRelevant,
      suggestedAngle:    tulos.suggestedAngle,
      aiSummary:         tulos.aiSummary,
      priorityScore:     tulos.salesPriority,
      contactAngle:      tulos.suggestedAngle,
      status:            'NEW',
    },
  })
}
