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

// ── Stage 2: Accessibility Classifier (säännöt, ei LLM) ──────────────────────

function classifyAccessibility(entities: ExtractedEntities): boolean {
  // Vaatii vähintään: mainitaan saavutettavuus JA digitaalinen palvelu
  if (!entities.mentions_accessibility) return false
  if (!entities.mentions_digital_service) return false
  return true
}

// ── Stage 3: Commercial Reasoning (vain relevanteille) ───────────────────────

interface CommercialReasoning {
  sector: 'public_authority' | 'private_company' | 'healthcare' | 'education' | 'ngo' | 'unknown'
  urgency: 'high' | 'medium' | 'low'
  suggested_angle: string
  summary: string
}

const COMMERCIAL_SYSTEM = `You are a sales intelligence agent for a digital accessibility consultancy.
You identify commercial opportunities from legal cases. Be concise and professional.
Sector angles:
- public_authority: EU Directive 2016/2102, legal obligation, sanctions
- private_company: competitive advantage, user base, ESG, reputation
- healthcare: patient rights, duty of care
- education: equal access, legal requirements
- ngo: mission alignment`

async function reasonCommercially(
  kase: CanonicalCase,
  entities: ExtractedEntities,
  client: Anthropic
): Promise<CommercialReasoning | null> {
  const lang = kase.country === 'FI' ? 'Finnish' : 'English'

  const prompt = `Commercial opportunity analysis:

Organization: ${entities.defendant_organization ?? 'unknown'}
Type: ${entities.organization_type}
WCAG mentioned: ${entities.mentions_wcag}
Service type: ${entities.service_type}
Case title: ${kase.title}

Return ONLY JSON:
{
  "sector": "public_authority | private_company | healthcare | education | ngo | unknown",
  "urgency": "high | medium | low",
  "suggested_angle": "1-2 sentences in ${lang}. Professional, no jargon.",
  "summary": "2-3 sentences in Finnish. What is the opportunity?"
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
      sector:          validSectors.includes(p.sector) ? p.sector : 'unknown',
      urgency:         ['high','medium','low'].includes(p.urgency) ? p.urgency : 'medium',
      suggested_angle: String(p.suggested_angle ?? '').slice(0, 500),
      summary:         String(p.summary ?? '').slice(0, 1000),
    }
  } catch {
    return null
  }
}

// ── Stage 4: Scoring Function (deterministinen koodi) ─────────────────────────

interface Scores {
  accessibilityRisk: number  // 0.0–1.0
  salesPriority: number      // 0–10
  confidence: number         // 0.0–1.0
  wcagRelevant: boolean
}

function calculateScore(
  entities: ExtractedEntities,
  wcagRelevant: boolean,
  commercial: CommercialReasoning | null
): Scores {
  if (!wcagRelevant) {
    return { accessibilityRisk: 0, salesPriority: 0, confidence: 0.9, wcagRelevant: false }
  }

  // Accessibility risk
  let risk = 0.3
  if (entities.mentions_wcag)            risk += 0.35
  if (entities.mentions_digital_service) risk += 0.20
  if (entities.service_type === 'website' || entities.service_type === 'mobile_app') risk += 0.10
  risk = Math.min(1, risk)

  // Sales priority
  let priority = 3
  if (entities.mentions_wcag)              priority += 3
  if (entities.organization_type === 'public') priority += 2  // lakivelvoite
  if (entities.service_type === 'website')     priority += 1
  if (commercial?.urgency === 'high')          priority += 1
  priority = Math.min(10, priority)

  // Confidence — laskee jos organisaatiota ei tunnistettu
  const confidence = entities.defendant_organization ? 0.82 : 0.45

  return { accessibilityRisk: risk, salesPriority: priority, confidence, wcagRelevant: true }
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
  const wcagRelevant = classifyAccessibility(entities)

  // Stage 3 — vain relevanteille
  const commercial = wcagRelevant
    ? await reasonCommercially(kase, entities, client)
    : null

  // Stage 4
  const scores = calculateScore(entities, wcagRelevant, commercial)

  return {
    organization:      entities.defendant_organization,
    sector:            commercial?.sector ?? 'unknown',
    accessibilityRisk: scores.accessibilityRisk,
    salesPriority:     scores.salesPriority,
    confidence:        scores.confidence,
    wcagRelevant:      scores.wcagRelevant,
    suggestedAngle:    commercial?.suggested_angle ?? '',
    aiSummary:         commercial?.summary ?? '',
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
