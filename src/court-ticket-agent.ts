/**
 * Court Ticket Agent — Risk → Revenue Mapping
 *
 * Claude ei analysoi oikeustapauksia — se tekee risk → revenue -mappingin.
 * Markkina kertoo itse kuka tarvitsee sinua.
 *
 * Input:  oikeustapaus (otsikko, tuomioistuin, tiivistelmä, koko teksti)
 * Output: organisaatio + sektori + accessibility_risk + sales_priority + confidence
 */

import Anthropic from '@anthropic-ai/sdk'
import { db } from './db/client'
import { FinlexTapaus } from './discovery/finlex'
import { RechtspraakTapaus } from './discovery/rechtspraak'

type Tapaus = (FinlexTapaus & { source: 'finlex' }) | (RechtspraakTapaus & { source: 'rechtspraak' })

export interface RiskRevenueMapping {
  organization: string | null
  sector: 'public_authority' | 'private_company' | 'healthcare' | 'education' | 'ngo' | 'unknown'
  accessibilityRisk: number   // 0.0–1.0: todennäköisyys että org tarvitsee digitaalista saavutettavuusapua
  salesPriority: number       // 0–10: myyntimahdollisuuden kiireellisyys ja arvo
  confidence: number          // 0.0–1.0: kuinka varma Claude on arviostaan
  wcagRelevant: boolean       // liittyykö tapaus digitaaliseen saavutettavuuteen
  suggestedAngle: string      // myyntikulma tämän sektorin ja tapauksen perusteella
  aiSummary: string
}

const SEKTOR_KULMAT: Record<string, string> = {
  public_authority: 'Julkiselle sektorille lakivelvoite on tärkein — direktiivi, sanktiot, julkinen vastuu.',
  private_company:  'Yksityiselle: kilpailuetu, kasvava käyttäjäkunta, maine ja vastuullisuus.',
  healthcare:       'Terveydenhuollossa: potilaiden oikeudet ja erityinen huolenpitovelvollisuus.',
  education:        'Koulutussektorilla: kaikkien oppijoiden tasa-arvoinen pääsy.',
  ngo:              'Järjestöille: missio edellyttää kaikkien tavoittamista.',
  unknown:          '',
}

function rakennaTapauksenTeksti(tapaus: Tapaus): string {
  const rivit: string[] = []

  if (tapaus.source === 'finlex') {
    rivit.push(`Source: Finlex (Finland)`)
    rivit.push(`Case: ${tapaus.viite ?? tapaus.url}`)
    rivit.push(`Title: ${tapaus.otsikko}`)
    if (tapaus.tuomioistuin) rivit.push(`Court: ${tapaus.tuomioistuin}`)
    if (tapaus.pvm)          rivit.push(`Date: ${tapaus.pvm}`)
    if (tapaus.katkelmia)    rivit.push(`Text excerpt: ${tapaus.katkelmia}`)
  } else {
    rivit.push(`Source: Rechtspraak.nl (Netherlands)`)
    rivit.push(`ECLI: ${tapaus.ecli}`)
    rivit.push(`Title: ${tapaus.otsikko}`)
    if (tapaus.tuomioistuin)    rivit.push(`Court: ${tapaus.tuomioistuin}`)
    if (tapaus.pvm)             rivit.push(`Date: ${tapaus.pvm}`)
    if (tapaus.menettelytyyppi) rivit.push(`Procedure: ${tapaus.menettelytyyppi}`)
    if (tapaus.tiivistelma)     rivit.push(`Summary: ${tapaus.tiivistelma}`)
  }

  return rivit.join('\n')
}

const PROMPT_SYSTEM = `You are a market intelligence agent for a digital accessibility consultancy.
Your job is NOT to summarize legal cases — it is to identify sales opportunities.

You perform risk → revenue mapping:
- Which organization is exposed?
- What sector are they in?
- How likely do they need digital accessibility help (WCAG, EN 301 549)?
- How urgent and valuable is this opportunity?
- How confident are you in your assessment?

Sector-specific sales angles:
- public_authority: Legal obligation (EU Directive 2016/2102), sanctions, public accountability
- private_company: Competitive advantage, growing user base, reputation, ESG
- healthcare: Patient rights, duty of care, regulatory pressure
- education: Equal access for all learners, legal requirements
- ngo: Mission alignment — reaching everyone

wcag_relevant = true ONLY if the case directly involves digital accessibility, websites, apps, or WCAG compliance.
If the case is about physical accessibility, criminal law, tax, or unrelated topics: wcag_relevant = false, sales_priority = 0.`

export async function analysoi(tapaus: Tapaus): Promise<RiskRevenueMapping | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('  [court-ticket-agent] ANTHROPIC_API_KEY puuttuu!')
    return null
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const tapausteksti = rakennaTapauksenTeksti(tapaus)

  const prompt = `Perform risk → revenue mapping for this legal case.

CASE DATA:
${tapausteksti}

Return ONLY valid JSON, no explanation:
{
  "organization": "Full organization name, or null if unidentifiable",
  "sector": "public_authority | private_company | healthcare | education | ngo | unknown",
  "accessibility_risk": 0.82,
  "sales_priority": 9,
  "confidence": 0.74,
  "wcag_relevant": true,
  "suggested_angle": "1-2 sentences. Sector-specific, professional, no jargon. Language: match the case country (Finnish for FI, English for NL).",
  "summary": "2-3 sentences in Finnish summarizing the opportunity."
}`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: PROMPT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return null

    const json = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
    const p = JSON.parse(json)

    const sector = ['public_authority','private_company','healthcare','education','ngo','unknown'].includes(p.sector)
      ? p.sector as RiskRevenueMapping['sector']
      : 'unknown'

    return {
      organization:      p.organization ?? null,
      sector,
      accessibilityRisk: Math.min(1, Math.max(0, Number(p.accessibility_risk ?? 0))),
      salesPriority:     Math.min(10, Math.max(0, Math.round(Number(p.sales_priority ?? 0)))),
      confidence:        Math.min(1, Math.max(0, Number(p.confidence ?? 0))),
      wcagRelevant:      Boolean(p.wcag_relevant),
      suggestedAngle:    String(p.suggested_angle ?? SEKTOR_KULMAT[sector] ?? '').slice(0, 500),
      aiSummary:         String(p.summary ?? '').slice(0, 1000),
    }
  } catch (e: any) {
    console.error('  [court-ticket-agent] Virhe:', e?.status ?? '', e?.message ?? e)
    return null
  }
}

export async function tallennaTiketti(
  tapaus: Tapaus,
  tulos: RiskRevenueMapping,
  maa: string
): Promise<void> {
  const caseRef = tapaus.source === 'finlex'
    ? (tapaus.viite ?? tapaus.url)
    : tapaus.ecli

  const caseTitle   = tapaus.otsikko
  const court       = tapaus.tuomioistuin
  const caseDate    = tapaus.pvm

  await db.courtLead.upsert({
    where: { caseRef },
    update: {
      orgName:          tulos.organization,
      sector:           tulos.sector,
      accessibilityRisk: tulos.accessibilityRisk,
      salesPriority:    tulos.salesPriority,
      confidence:       tulos.confidence,
      wcagRelevant:     tulos.wcagRelevant,
      suggestedAngle:   tulos.suggestedAngle,
      aiSummary:        tulos.aiSummary,
      // legacy
      priorityScore:    tulos.salesPriority,
      contactAngle:     tulos.suggestedAngle,
    },
    create: {
      source:    tapaus.source,
      caseRef,
      caseUrl:   tapaus.url,
      caseTitle,
      court,
      caseDate,
      country:   maa,
      orgName:           tulos.organization,
      sector:            tulos.sector,
      accessibilityRisk: tulos.accessibilityRisk,
      salesPriority:     tulos.salesPriority,
      confidence:        tulos.confidence,
      wcagRelevant:      tulos.wcagRelevant,
      suggestedAngle:    tulos.suggestedAngle,
      aiSummary:         tulos.aiSummary,
      // legacy
      priorityScore:     tulos.salesPriority,
      contactAngle:      tulos.suggestedAngle,
      status: 'NEW',
    },
  })
}
