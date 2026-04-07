/**
 * Court Ticket Agent
 *
 * Claude analysoi oikeustapauksen ja luo strukturoidun tiketin:
 * - Organisaatio
 * - Rikkomuksen vakavuus (0–10)
 * - Ehdotettu yhteydenottokulma suomeksi/englanniksi
 * - Lyhyt tiivistelmä
 */

import Anthropic from '@anthropic-ai/sdk'
import { db } from './db/client'
import { FinlexTapaus } from './discovery/finlex'
import { RechtspraakTapaus } from './discovery/rechtspraak'

type Tapaus = (FinlexTapaus & { source: 'finlex' }) | (RechtspraakTapaus & { source: 'rechtspraak' })

export interface Tikettitulos {
  orgName: string | null
  priorityScore: number       // 0–10
  contactAngle: string        // ehdotettu lähestymistapa
  aiSummary: string           // lyhyt tiivistelmä
}

function rakennaTapauksenTeksti(tapaus: Tapaus): string {
  if (tapaus.source === 'finlex') {
    return [
      `Lähde: Finlex (Suomi)`,
      `Viite: ${tapaus.viite ?? tapaus.url}`,
      `Otsikko: ${tapaus.otsikko}`,
      tapaus.tuomioistuin ? `Tuomioistuin: ${tapaus.tuomioistuin}` : '',
      tapaus.pvm ? `Päivämäärä: ${tapaus.pvm}` : '',
      tapaus.katkelmia ? `Katkelma: ${tapaus.katkelmia}` : '',
    ].filter(Boolean).join('\n')
  } else {
    return [
      `Lähde: Rechtspraak.nl (Hollanti)`,
      `ECLI: ${tapaus.ecli}`,
      `Otsikko: ${tapaus.otsikko}`,
      tapaus.tuomioistuin ? `Tuomioistuin: ${tapaus.tuomioistuin}` : '',
      tapaus.pvm ? `Päivämäärä: ${tapaus.pvm}` : '',
      tapaus.menettelytyyppi ? `Menettely: ${tapaus.menettelytyyppi}` : '',
      tapaus.tiivistelma ? `Tiivistelmä: ${tapaus.tiivistelma}` : '',
    ].filter(Boolean).join('\n')
  }
}

export async function analysoi(tapaus: Tapaus): Promise<Tikettitulos | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const tapausteksti = rakennaTapauksenTeksti(tapaus)

  const prompt = `Olet saavutettavuusasiantuntijan assistentti. Analysoi seuraava oikeustapaus ja luo myyntitiiketti.

TAPAUS:
${tapausteksti}

Tehtäväsi:
1. Tunnista organisaatio jota asia koskee (vastaaja/kohde, ei valittaja)
2. Arvioi tapauksen kiireellisyys myyntimahdollisuutena (0–10)
   - 10 = tuore tuomio, iso organisaatio, selvä WCAG-rike
   - 0 = epäselvä, vanha, tai ei relevantti saavutettavuuspalvelulle
3. Ehdota lyhyt yhteydenottokulma (1–2 lausetta, ammattimainen, ei myyntijargoni)
4. Kirjoita tiivistelmä tapauksen ydinasioista (max 150 sanaa)

Vastaa VAIN JSON-muodossa (älä lisää selityksiä):
{
  "orgName": "Organisaation nimi tai null jos ei tunnistettavissa",
  "priorityScore": 7,
  "contactAngle": "Ehdotettu yhteydenotto suomeksi tai englanniksi riippuen maasta",
  "aiSummary": "Tiivistelmä suomeksi"
}`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return null

    const json = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
    const parsed = JSON.parse(json)

    return {
      orgName: parsed.orgName ?? null,
      priorityScore: Math.min(10, Math.max(0, Math.round(Number(parsed.priorityScore ?? 0)))),
      contactAngle: String(parsed.contactAngle ?? '').slice(0, 500),
      aiSummary: String(parsed.aiSummary ?? '').slice(0, 1000),
    }
  } catch (e: any) {
    console.error('  [court-ticket-agent] Virhe:', e?.message ?? e)
    return null
  }
}

export async function tallennaTiketti(
  tapaus: Tapaus,
  tulos: Tikettitulos,
  maa: string
): Promise<void> {
  const caseRef = tapaus.source === 'finlex'
    ? (tapaus.viite ?? tapaus.url)
    : tapaus.ecli

  const caseTitle = tapaus.source === 'finlex'
    ? tapaus.otsikko
    : tapaus.otsikko

  const court = tapaus.source === 'finlex'
    ? tapaus.tuomioistuin
    : tapaus.tuomioistuin

  const caseDate = tapaus.source === 'finlex'
    ? tapaus.pvm
    : tapaus.pvm

  await db.courtLead.upsert({
    where: { caseRef },
    update: {
      priorityScore: tulos.priorityScore,
      contactAngle: tulos.contactAngle,
      aiSummary: tulos.aiSummary,
      orgName: tulos.orgName,
    },
    create: {
      source: tapaus.source,
      caseRef,
      caseUrl: tapaus.url,
      caseTitle,
      court,
      caseDate,
      country: maa,
      orgName: tulos.orgName,
      priorityScore: tulos.priorityScore,
      contactAngle: tulos.contactAngle,
      aiSummary: tulos.aiSummary,
      status: 'NEW',
    },
  })
}
