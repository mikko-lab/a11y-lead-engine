import Anthropic from '@anthropic-ai/sdk'
import { Violation } from './scanner'

// ── GEO snippet ───────────────────────────────────────────────────────────────

async function extractHeroSnippet(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GEO-Agent/1.0)' },
      signal: AbortSignal.timeout(10000),
    })
    const html = await res.text()
    // Poista script/style/nav/header/footer ennen parsintaa
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    // Hae ensimmäinen järkevän kokoinen <p>
    const matches = cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)
    for (const m of matches) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (text.length >= 60 && text.length <= 500) return text
    }
    return null
  } catch {
    return null
  }
}

export async function generateGeoSnippet(
  url: string
): Promise<{ original: string; optimized: string } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const original = await extractHeroSnippet(url)
  if (!original) return null

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Muunna tämä tekstikappale AI-hakukoneille optimoituun muotoon:
– aloita kysymyksellä
– anna suora vastaus
– lisää yksi konkreettinen fakta tai esimerkki (käytä VAIN alkuperäisen tekstin tietoja, älä keksi uusia)
– pidä pituus max 120 sanaa
– tee siitä helposti siteerattava

Alkuperäinen teksti:
"${original}"

Vastaa VAIN optimoitu teksti, ei selityksiä.`,
      }],
    })
    const optimized = msg.content[0].type === 'text' ? msg.content[0].text.trim() : null
    if (!optimized) return null
    return { original, optimized }
  } catch (e: any) {
    console.error('  [GEO snippet] Virhe:', e?.message ?? e)
    return null
  }
}

export async function generateAiSummary(
  violations: Violation[],
  url: string,
  siteContext?: string
): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  if (violations.length === 0) return null

  const top = violations
    .filter(v => v.impact === 'critical' || v.impact === 'serious')
    .slice(0, 6)
    .map(v => {
      const contrastNote = v.contrastRatio && v.expectedContrastRatio
        ? ` — kontrasti ${v.contrastRatio.toFixed(1)}:1 (vaaditaan ${v.expectedContrastRatio})`
        : ''
      return `- [${v.impact}] ${v.help}${contrastNote} (${v.wcag})`
    })
    .join('\n')

  if (!top) return null

  const contextLine = siteContext
    ? `Sivuston tyyppi: ${siteContext}.`
    : ''

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 450,
      messages: [{
        role: 'user',
        content: `Olet saavutettavuusasiantuntija. Alla on lista teknisistä havainnoista sivustolta ${url}. ${contextLine}

${top}

Kirjoita lyhyt yhteenveto (max 3 kohtaa) yritysjohtajalle, joka ei tunne teknistä termistöä. Kerro konkreettisesti, miten kukin ongelma haittaa oikeaa asiakasta tai liiketoimintaa. ${siteContext ? `Mainitse tarvittaessa miten ongelma liittyy tämän tyyppiseen liiketoimintaan (${siteContext}).` : ''}

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
