import { jsPDF } from 'jspdf'
import { ScanResult, Violation } from './scanner'

type RGB = [number, number, number]

const C = {
  ink:        [15,  23,  42]  as RGB,
  inkMid:     [51,  65,  85]  as RGB,
  inkMute:    [100, 116, 139] as RGB,
  brand:      [37,  99,  235] as RGB,
  line:       [226, 232, 240] as RGB,
  surface:    [248, 250, 252] as RGB,
  white:      [255, 255, 255] as RGB,
  critBg:     [255, 237, 213] as RGB,
  critFg:     [154, 52,  18]  as RGB,
  critAccent: [234, 88,  12]  as RGB,
  modBg:      [254, 243, 199] as RGB,
  modFg:      [120, 53,  15]  as RGB,
  modAccent:  [217, 119, 6]   as RGB,
  serBg:      [254, 226, 226] as RGB,
  serFg:      [153, 27,  27]  as RGB,
  serAccent:  [220, 38,  38]  as RGB,
  infoBg:     [219, 234, 254] as RGB,
  infoFg:     [30,  64,  175] as RGB,
  infoAccent: [37,  99,  235] as RGB,
}

type Severity = 'critical' | 'serious' | 'moderate' | 'info'

const SEV_TOKENS: Record<Severity, { bg: RGB; fg: RGB; accent: RGB; label: string }> = {
  critical: { bg: C.critBg, fg: C.critFg, accent: C.critAccent, label: 'KRIITTINEN' },
  serious:  { bg: C.serBg,  fg: C.serFg,  accent: C.serAccent,  label: 'VAKAVA'     },
  moderate: { bg: C.modBg,  fg: C.modFg,  accent: C.modAccent,  label: 'KOHTALAINEN'},
  info:     { bg: C.infoBg, fg: C.infoFg, accent: C.infoAccent, label: 'KUNNOSSA'   },
}

function impactToSeverity(impact: string | null): Severity {
  if (impact === 'critical') return 'critical'
  if (impact === 'serious')  return 'serious'
  if (impact === 'moderate') return 'moderate'
  return 'info'
}

function scoreColor(score: number): RGB {
  if (score >= 80) return [29, 78, 216]
  if (score >= 50) return [146, 64, 14]
  return [180, 83, 9]
}

export function generatePdf(scan: ScanResult, senderName: string, senderUrl: string): Buffer {
  const doc     = new jsPDF({ unit: 'mm', format: 'a4' })
  const pageW   = doc.internal.pageSize.getWidth()
  const pageH   = doc.internal.pageSize.getHeight()
  const margin  = 20
  const cW      = pageW - margin * 2
  const footerH = 14
  const bodyBot = pageH - footerH - 6

  const scannedAt = new Date(scan.timestamp).toLocaleString('fi-FI')
  const sc = scoreColor(scan.score)

  const pageState = { page: 1 }
  let y = margin

  const addFooter = (pageNum: number, total: number) => {
    const fy = pageH - footerH + 5
    doc.setDrawColor(...C.line)
    doc.setLineWidth(0.3)
    doc.line(margin, pageH - footerH, pageW - margin, pageH - footerH)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...C.inkMute)
    doc.text(`info@${senderUrl.replace('https://', '')}`, margin, fy)
    doc.text(senderUrl.replace('https://', ''), pageW / 2, fy, { align: 'center' })
    doc.text(`Sivu ${pageNum} / ${total}`, pageW - margin, fy, { align: 'right' })
  }

  const checkBreak = (needed: number) => {
    if (y + needed > bodyBot) {
      addFooter(pageState.page, 0)
      doc.addPage()
      pageState.page++
      doc.setDrawColor(...C.line)
      doc.setLineWidth(0.3)
      doc.line(margin, margin, pageW - margin, margin)
      y = margin + 8
    }
  }

  // ── Header ───────────────────────────────────────────────────────────────
  doc.setFillColor(...C.brand)
  doc.rect(0, 0, pageW, 2, 'F')
  y = 12

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(...C.ink)
  doc.text('Saavutettavuusraportti', margin, y)
  y += 7

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...C.inkMute)
  doc.text('WCAG 2.2 AA', margin, y)
  doc.setTextColor(...C.inkMid)
  doc.text(`Skannattu ${scannedAt}`, pageW - margin, y, { align: 'right' })
  y += 5

  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...C.inkMute)
  const urlLabel = 'Osoite: '
  doc.text(urlLabel, margin, y)
  doc.setFont('helvetica', 'normal')
  const urlLines = doc.splitTextToSize(scan.url, cW - doc.getTextWidth(urlLabel))
  doc.text(urlLines, margin + doc.getTextWidth(urlLabel), y)
  y += urlLines.length * 4.5 + 6

  // ── Score card ───────────────────────────────────────────────────────────
  const cardH = 34
  doc.setFillColor(...C.surface)
  doc.setDrawColor(...C.line)
  doc.setLineWidth(0.4)
  doc.roundedRect(margin, y, cW, cardH, 3, 3, 'FD')

  const cp = 8
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(28)
  doc.setTextColor(...sc)
  doc.text(String(scan.score), margin + cp, y + 14)
  const sw = doc.getTextWidth(String(scan.score))
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(...C.inkMute)
  doc.text('/ 100', margin + cp + sw + 2, y + 14)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...C.inkMid)
  doc.text('Kokonaispisteet', margin + cp, y + 21)

  const barX = margin + cp
  const barY = y + 26
  const barW = cW - cp * 2
  doc.setFillColor(...C.line)
  doc.roundedRect(barX, barY, barW, 3.5, 1.5, 1.5, 'F')
  doc.setFillColor(...sc)
  doc.roundedRect(barX, barY, (scan.score / 100) * barW, 3.5, 1.5, 1.5, 'F')

  const stats = [
    { label: 'Kriittistä',  value: scan.critical, color: C.critAccent },
    { label: 'Vakavia',     value: scan.serious,  color: C.serAccent  },
    { label: 'Kohtalaisia', value: scan.moderate, color: C.modAccent  },
    { label: 'Kunnossa',    value: scan.passed,   color: C.infoAccent },
  ]
  const colW = (cW - cp * 2 - sw - 30) / stats.length
  let sx = pageW - margin - stats.length * colW
  for (const s of stats) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.setTextColor(...s.color)
    doc.text(String(s.value), sx + colW / 2, y + 14, { align: 'center' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...C.inkMute)
    doc.text(s.label, sx + colW / 2, y + 20, { align: 'center' })
    sx += colW
  }

  y += cardH + 10

  // ── Section heading ───────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(...C.ink)
  doc.text('Löydetyt ongelmat', margin, y)
  y += 2
  doc.setFillColor(...C.brand)
  doc.rect(margin, y, 20, 0.8, 'F')
  y += 7

  // ── Disclaimer ────────────────────────────────────────────────────────────
  const disc = 'Huom: Tämä tarkistus on automaattinen ja tunnistaa arviolta noin 20 % WCAG 2.2 AA -ongelmista. Täydellinen saavutettavuusarviointi edellyttää manuaalista testausta. Raportti ei ole virallinen vaatimustenmukaisuuslausunto.'
  const discLines = doc.splitTextToSize(disc, cW - 8)
  const discH = discLines.length * 4.5 + 6
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(...C.line)
  doc.setLineWidth(0.3)
  doc.roundedRect(margin, y, cW, discH, 2, 2, 'FD')
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...C.inkMid)
  doc.text(discLines, margin + 4, y + 5)
  y += discH + 8

  // ── Issue cards ───────────────────────────────────────────────────────────
  const issueViolations = scan.violations.filter((v) => v.impact !== null)

  for (const violation of issueViolations) {
    const sev = impactToSeverity(violation.impact)
    const tok = SEV_TOKENS[sev]

    doc.setFontSize(10)
    const descLines = doc.splitTextToSize(violation.description, cW - 16)
    doc.setFontSize(9)
    const suggLines = doc.splitTextToSize(violation.help, cW - 16)
    let elLines: string[] = []
    if (violation.element) {
      doc.setFont('courier', 'normal')
      doc.setFontSize(7.5)
      elLines = doc.splitTextToSize(violation.element, cW - 20)
      doc.setFont('helvetica', 'normal')
    }

    const estH =
      8 +
      descLines.length * 5.5 + 2 +
      suggLines.length * 4.8 + 2 +
      (elLines.length ? elLines.length * 4 + 6 : 0) +
      6

    checkBreak(estH)

    doc.setFillColor(...C.white)
    doc.setDrawColor(...C.line)
    doc.setLineWidth(0.35)
    doc.roundedRect(margin, y, cW, estH, 2.5, 2.5, 'FD')

    doc.setFillColor(...tok.accent)
    doc.roundedRect(margin, y, 3, estH, 2, 2, 'F')
    doc.rect(margin + 1.5, y, 1.5, estH, 'F')

    const inner = margin + 10
    const innerW = cW - 14
    let cy = y + 6

    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'bold')
    const bw = doc.getTextWidth(tok.label) + 5
    doc.setFillColor(...tok.bg)
    doc.roundedRect(inner, cy - 3.5, bw, 5, 1.5, 1.5, 'F')
    doc.setTextColor(...tok.fg)
    doc.text(tok.label, inner + 2.5, cy)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...C.inkMute)
    doc.text(violation.wcag, inner + bw + 3, cy)
    cy += 6

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...C.ink)
    doc.text(descLines, inner, cy)
    cy += descLines.length * 5.5 + 2

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...C.inkMid)
    doc.text('Korjaus:', inner, cy)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...C.inkMute)
    doc.text(suggLines, inner + doc.getTextWidth('Korjaus:') + 2, cy)
    cy += suggLines.length * 4.8 + 2

    if (violation.element) {
      doc.setFont('courier', 'normal')
      doc.setFontSize(7.5)
      const codeLines = doc.splitTextToSize(violation.element, innerW - 6)
      const codeH = codeLines.length * 4 + 5
      doc.setFillColor(...C.surface)
      doc.setDrawColor(...C.line)
      doc.setLineWidth(0.25)
      doc.roundedRect(inner, cy, innerW, codeH, 1.5, 1.5, 'FD')
      doc.setTextColor(...C.inkMid)
      doc.text(codeLines, inner + 3, cy + 4)
    }

    y += estH + 4
  }

  // ── CTA ──────────────────────────────────────────────────────────────────
  checkBreak(36)
  y += 6
  const ctaH = 30
  doc.setFillColor(10, 37, 64)
  doc.roundedRect(margin, y, cW, ctaH, 3, 3, 'F')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(255, 255, 255)
  doc.text('Haluatteko ongelmat korjattua?', margin + cW / 2, y + 11, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(0, 212, 170)
  doc.text('Tilaa saavutettavuusauditointi', margin + cW / 2, y + 18, { align: 'center' })

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  doc.setTextColor(148, 163, 184)
  doc.text(senderUrl + '#hinnoittelu', margin + cW / 2, y + 24, { align: 'center' })

  y += ctaH + 6

  // ── Footers ───────────────────────────────────────────────────────────────
  const total = (doc.internal as any).getNumberOfPages()
  for (let p = 1; p <= total; p++) {
    doc.setPage(p)
    addFooter(p, total)
  }

  return Buffer.from(doc.output('arraybuffer'))
}
