import nodemailer from 'nodemailer'
import { marked } from 'marked'
import { ScanResult } from './scanner'

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}


export async function sendReport(opts: {
  to: string
  scan: ScanResult
  reportUrl: string
  optOutUrl: string
  aiSummary?: string | null
  senderName: string
  senderUrl: string
}): Promise<void> {
  const { to, scan, reportUrl, optOutUrl, aiSummary, senderName, senderUrl } = opts
  const transporter = createTransport()
  const domain = new URL(scan.url).hostname
  const score = scan.score
  const issueCount = scan.critical + scan.serious
  const subjectIssueLabel = issueCount === 1 ? '1 korjattava kohta' : `${issueCount} korjattavaa kohtaa`

  // Positiivinen tai neutraali arvio pisteiden mukaan
  const scoreComment = score >= 85
    ? `Sivustonne on teknisesti <strong>erinomaisella tasolla</strong> — tulos ${score}/100 on selvästi keskiarvon yläpuolella.`
    : score >= 70
    ? `Sivustonne sai saavutettavuusskannuksessa tuloksen <strong>${score}/100</strong>, mikä on hyvä lähtökohta.`
    : `Ajoin sivustollenne saavutettavuusskannauksen (WCAG 2.2 AA) ja tulos oli <strong>${score}/100</strong>.`

  // Markdown → HTML (AI-yhteenveto)
  const aiHtml = aiSummary
    ? marked.parse(aiSummary, { async: false }) as string
    : null

  const html = `<!DOCTYPE html>
<html lang="fi">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  :root { color-scheme: light; }
  body { color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    body { background-color: #ffffff !important; color: #1a1a1a !important; }
  }
</style>
</head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; font-size: 16px; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #ffffff;">

  <!-- Preheader: näkyy sähköpostiohjelman esikatselussa mutta ei itse viestissä -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Ajoimme sivustollenne kevyen saavutettavuusskannauksen ja tulos oli ${score >= 85 ? 'loistava' : 'hyvä'} ${score}/100. Tässä yksi huomio...&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌</div>

  <p style="margin: 0 0 20px; line-height: 1.6;">Hei,</p>

  <p style="margin: 0 0 20px; line-height: 1.6;">${scoreComment}</p>

  ${issueCount > 0 ? `<p style="margin: 0 0 24px; line-height: 1.6;">Vaikka perusasiat ovat kunnossa, sivustolle on jäänyt <strong>${subjectIssueLabel}</strong>, ${issueCount === 1 ? 'joka' : 'jotka'} on kuitenkin helppo korjata:</p>` : ''}

  ${aiHtml ? `
  <div style="background: #f8fafc; border-left: 3px solid #0A2540; padding: 16px 20px; margin: 0 0 28px; border-radius: 0 6px 6px 0; line-height: 1.7; color: #1a1a1a;">
    ${aiHtml}
  </div>` : ''}

  <p style="margin: 0 0 16px; line-height: 1.6;">Koostin löydöksistä teille lyhyen ja ilmaisen raportin. Näette tarkan ongelmakohdan suoraan tästä linkistä:</p>

  <a href="${reportUrl}" style="display: inline-block; background: #0A2540; color: #ffffff; font-weight: 600; font-size: 15px; padding: 14px 28px; border-radius: 6px; text-decoration: none; margin-bottom: 28px;">
    👉 Katso sivustonne saavutettavuusraportti
  </a>

  <p style="margin: 0 0 16px; line-height: 1.6;">Suurin osa vastaavista ongelmista on korjattavissa muutamassa tunnissa. Useimmat auditoinnit jäävät raporttitasolle — minä voin halutessanne auttaa viemään korjaukset suoraan tuotantoon asti.</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 28px 0;">

  <p style="margin: 0 0 24px; color: #475569; font-size: 14px; line-height: 1.8;">
    Ystävällisin terveisin,<br>
    <strong style="color: #1a1a1a;">${senderName}</strong><br>
    <a href="https://wpsaavutettavuus.fi" style="color: #475569;">wpsaavutettavuus.fi</a>
  </p>

  <p style="margin: 0; color: #475569; font-size: 12px; line-height: 1.7; border-top: 1px solid #e2e8f0; padding-top: 16px;">
    Sait tämän viestin, koska yrityksenne verkkosivusto löytyi julkisesta hakemistosta.<br>
    Jos et halua vastaavia viestejä jatkossa, <a href="${optOutUrl}" style="color: #1a1a1a;">peru tilaus tästä</a>.
  </p>

</body>
</html>`

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Pieni kehitysehdotus sivustonne (${domain}) saavutettavuuteen`,
    html,
  })
}
