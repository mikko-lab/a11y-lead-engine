// Scoring gate -raja-arvot
// score < SCORE_MIN          → liian rikki, ohitetaan
// score >= QUALIFIED_THRESHOLD + email → QUALIFIED → sähköposti lähtee
export const SCORE_MIN           = 40
export const QUALIFIED_THRESHOLD = 70

// Palauttaa ms seuraavaan arkiaamuun klo 8:00–9:59 (Helsinki-aika)
export function msUntilNextSendWindow(): number {
  const randomMins = Math.floor(Math.random() * 120) // 0–119 min klo 8 jälkeen
  const sendHour = 8 + Math.floor(randomMins / 60)
  const sendMin  = randomMins % 60

  const now = new Date()

  function helsinkiParts(d: Date) {
    const parts: Record<string, string> = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Helsinki',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(d)) parts[p.type] = p.value
    return {
      hour: parseInt(parts.hour) % 24,
      minute: parseInt(parts.minute),
      weekday: parts.weekday,
    }
  }

  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const trial = new Date(now.getTime() + daysAhead * 86_400_000)
    const p = helsinkiParts(trial)
    const diffMins = (sendHour * 60 + sendMin) - (p.hour * 60 + p.minute)
    const candidate = new Date(trial.getTime() + diffMins * 60_000)
    if (candidate.getTime() <= now.getTime()) continue
    const cp = helsinkiParts(candidate)
    if (cp.weekday === 'Sat' || cp.weekday === 'Sun') continue
    return candidate.getTime() - now.getTime()
  }

  return 24 * 60 * 60 * 1000 // fallback
}
