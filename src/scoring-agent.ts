import Anthropic from '@anthropic-ai/sdk'

export interface ScoringInput {
  score: number
  critical: number
  serious: number
  moderate: number
  revenue?: number | null
  employees?: number | null
  tolName?: string | null
  isWordPress: boolean
  hasCta: boolean | null
  hasAccessibilityStatement: boolean | null
}

export interface ScoringResult {
  priorityScore: number  // 0–10
  priorityReason: string // yksi lause
}

export async function scoreLead(input: ScoringInput): Promise<ScoringResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const revenueStr = input.revenue
    ? input.revenue >= 1_000_000
      ? `${(input.revenue / 1_000_000).toFixed(1)} M€`
      : `${Math.round(input.revenue / 1000)} t€`
    : 'ei tiedossa'

  const prompt = `Arvioi suomalaisen yrityksen potentiaali saavutettavuuspalvelulle asteikolla 0–10.

WCAG-tulos: ${input.score}/100
Kriittiset ongelmat: ${input.critical}
Vakavat ongelmat: ${input.serious}
Kohtalaiset ongelmat: ${input.moderate}
Liikevaihto: ${revenueStr}
Henkilöstö: ${input.employees ?? 'ei tiedossa'}
Toimiala: ${input.tolName ?? 'ei tiedossa'}
WordPress: ${input.isWordPress ? 'kyllä' : 'ei'}
CTA-elementti: ${input.hasCta ? 'kyllä' : 'ei'}
Saavutettavuusseloste: ${input.hasAccessibilityStatement ? 'on' : 'ei ole'}

Korkea pisteet = iso firma + vakavia ongelmia + ei tietoisuutta saavutettavuudesta.
Matala pisteet = pieni firma / lähes virheetön / jo tietoinen ongelmista.

Vastaa VAIN JSON-muodossa:
{"score": 7, "reason": "Yksi lause miksi tämä on hyvä tai huono liidi."}`

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!text) return null

    const parsed = JSON.parse(text)
    const priorityScore = Math.min(10, Math.max(0, Math.round(Number(parsed.score))))
    const priorityReason = String(parsed.reason ?? '').slice(0, 200)

    if (isNaN(priorityScore)) return null
    return { priorityScore, priorityReason }
  } catch (e: any) {
    console.error('  [scoring-agent] Virhe:', e?.message ?? e)
    return null
  }
}
