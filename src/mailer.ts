import nodemailer from 'nodemailer'
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
  pdf: Buffer
  senderName: string
  senderUrl: string
}): Promise<void> {
  const { to, scan, pdf, senderName, senderUrl } = opts
  const transporter = createTransport()
  const domain = new URL(scan.url).hostname
  const score = scan.score
  const level = score >= 80 ? 'hyvä' : score >= 50 ? 'kohtalainen' : 'heikko'

  const html = `
<!DOCTYPE html>
<html lang="fi">
<head><meta charset="UTF-8"></head>
<body style="font-family: 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">

  <div style="background: #0A2540; border-radius: 8px; padding: 24px 28px; margin-bottom: 24px;">
    <p style="color: #00D4AA; font-size: 13px; margin: 0 0 4px;">WCAG 2.2 AA -saavutettavuusraportti</p>
    <h1 style="color: #fff; font-size: 22px; margin: 0;">${domain}</h1>
  </div>

  <p>Hei,</p>

  <p>Teetimme automaattisen saavutettavuustarkistuksen sivustollenne <strong>${scan.url}</strong>.</p>

  <div style="background: #f8fafc; border: 1px solid #e5e8eb; border-radius: 8px; padding: 20px; margin: 20px 0;">
    <p style="margin: 0 0 12px; font-size: 14px; color: #5a5a5a;">Saavutettavuuspisteet</p>
    <p style="font-size: 42px; font-weight: 700; margin: 0; color: ${score >= 80 ? '#1D4ED8' : score >= 50 ? '#92400E' : '#B45309'};">
      ${score}<span style="font-size: 18px; color: #888;"> / 100</span>
    </p>
    <p style="margin: 8px 0 0; color: #5a5a5a; font-size: 14px;">Taso: <strong>${level}</strong></p>
  </div>

  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr>
      <td style="padding: 10px; text-align: center; background: #fff8e1; border-radius: 6px;">
        <div style="font-size: 28px; font-weight: 700; color: #ea580c;">${scan.critical}</div>
        <div style="font-size: 12px; color: #7c3500;">Kriittistä</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 10px; text-align: center; background: #fef9c3; border-radius: 6px;">
        <div style="font-size: 28px; font-weight: 700; color: #d97706;">${scan.serious}</div>
        <div style="font-size: 12px; color: #7c5c00;">Vakavia</div>
      </td>
      <td style="width: 8px;"></td>
      <td style="padding: 10px; text-align: center; background: #eff6ff; border-radius: 6px;">
        <div style="font-size: 28px; font-weight: 700; color: #1d4ed8;">${scan.passed}</div>
        <div style="font-size: 12px; color: #1e3a8a;">Kunnossa</div>
      </td>
    </tr>
  </table>

  <p>Liitteenä on yksityiskohtainen raportti löydetyistä ongelmista ja korjausehdotuksista.</p>

  <p>Saavutettavuusvaatimukset koskevat yhä useampia sivustoja, ja puutteet voivat johtaa oikeudellisiin riskeihin. Autamme korjaamaan ongelmat nopeasti.</p>

  <a href="${senderUrl}" style="display: inline-block; background: #00D4AA; color: #0A2540; font-weight: 700; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 8px 0;">
    Lue lisää →
  </a>

  <p style="margin-top: 32px; color: #888; font-size: 13px;">
    ${senderName} · <a href="${senderUrl}" style="color: #888;">${senderUrl.replace('https://', '')}</a>
  </p>

</body>
</html>`

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Saavutettavuusraportti: ${domain} — pisteet ${score}/100`,
    html,
    attachments: [
      {
        filename: `saavutettavuusraportti-${domain}-${new Date().toISOString().split('T')[0]}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  })
}
