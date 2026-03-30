import Anthropic from '@anthropic-ai/sdk'
import { Violation } from './scanner'

export async function generateAiSummary(violations: Violation[], url: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  if (violations.length === 0) return null

  const top = violations
    .filter(v => v.impact === 'critical' || v.impact === 'serious')
    .slice(0, 6)
    .map(v => `- [${v.impact}] ${v.help} (${v.wcag})`)
    .join('\n')

  if (!top) return null

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Olet saavutettavuusasiantuntija. Alla on lista teknisistä saavutettavuusvirheistä sivustolta ${url}.

${top}

Kirjoita lyhyt yhteenveto (max 3 kohtaa) yritysjohtajalle, joka ei tunne teknistä termistöä. Kerro konkreettisesti, miten kukin ongelma haittaa oikeaa asiakasta tai liiketoimintaa.

Säännöt:
- Kirjoita selkeää suomea. Älä käytä englannista johdettuja sanoja kuten "rankata" — käytä "sijoittua hakutuloksissa".
- Älä sekoita eri ongelmien vaikutuksia. Jos ongelma koskee värikontrastia, puhu näkövaikeuksista — ei ruudunlukijoista.
- Puhu "asiakkaista" tai "käyttäjistä", ei teknisistä termeistä.
- Jokainen kohta enintään 2 virkettä.
- Käytä muotoa: **Otsikko** (lihavoitu) + lyhyt selitys.`,
      }],
    })

    const text = msg.content[0].type === 'text' ? msg.content[0].text : null
    return text?.trim() ?? null
  } catch (e: any) {
    console.error('  [AI] Virhe:', e?.message ?? e)
    return null
  }
}
