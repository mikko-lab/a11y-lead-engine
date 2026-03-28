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

const VIOLATION_FI: Record<string, string> = {
  'link-name':         'Osa linkeistä on käyttäjälle epäselviä — erityisesti ruudunlukijalla',
  'color-contrast':    'Tekstin kontrasti on liian heikko — vaikea lukea heikkonäköiselle',
  'image-alt':         'Kuvista puuttuu tekstivaihtoehto — ruudunlukija ohittaa ne kokonaan',
  'label':             'Lomakekentistä puuttuu otsikot — käyttäjä ei tiedä mitä kirjoittaa',
  'button-name':       'Osa painikkeista on nimettömiä — ruudunlukija ei osaa kuvata niitä',
  'heading-order':     'Otsikkohierarkia on sekava — vaikeuttaa sivun hahmottamista',
  'html-has-lang':     'Sivun kieli puuttuu — ruudunlukija ei osaa valita oikeaa ääntämistä',
  'aria-required-attr':'ARIA-määritteitä käytetään väärin — apuvälineet tulkitsevat sivun virheellisesti',
  'region':            'Sivun rakenne on jäsentymätön — navigointi apuvälineillä on vaikeaa',
  'duplicate-id':      'Sivulla on toistuvia tunnisteita — voi aiheuttaa arvaamattomia virheitä',
  'frame-title':       'Upotetut kehykset ovat nimettömiä — sisältö jää piiloon ruudunlukijalta',
  'list':              'Listat on toteutettu väärin — rakenne ei välity apuvälineille',
  'listitem':          'Listaelementtejä käytetään väärässä yhteydessä — rakenne hajoaa',
  'td-headers-attr':   'Taulukon solut eivät yhdisty otsikoihin — taulukko on epäselvä',
  'th-has-data-cells': 'Taulukon otsikkosoluilla ei ole vastaavia tietoja — rakenne on virheellinen',
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

  const topViolation =
    scan.violations.find(v => v.impact === 'critical') ||
    scan.violations.find(v => v.impact === 'serious') ||
    scan.violations[0]

  const topFinding = topViolation
    ? (VIOLATION_FI[topViolation.id] ?? topViolation.help)
    : null

  const issueCount = scan.critical + scan.serious
  const issueLabel = issueCount === 1 ? '1 vakava ongelma' : `${issueCount} vakavaa ongelmaa`
  const subjectIssueLabel = issueCount === 1 ? '1 vakava' : `${issueCount} vakavaa`

  const html = `
<!DOCTYPE html>
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

  <p style="margin: 0 0 20px; line-height: 1.6;">Hei,</p>

  <p style="margin: 0 0 20px; line-height: 1.6;">skannasin sivustonne <strong>${scan.url}</strong> saavutettavuuden (WCAG 2.2 AA).</p>

  <p style="margin: 0 0 8px; line-height: 1.6;">👉 Tulos: <strong>${score} / 100</strong></p>
  <p style="margin: 0 0 24px; line-height: 1.6; font-size: 18px; font-weight: 700;">⚠️ ${issueLabel}</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">

  ${topFinding ? `
  <p style="margin: 0 0 12px; font-weight: 700; line-height: 1.6;">⚠️ Merkittävin havainto</p>

  <p style="margin: 0 0 16px; line-height: 1.6;">${topFinding}.</p>

  <p style="margin: 0 0 8px; line-height: 1.6;">Tämä tarkoittaa käytännössä sitä, että:</p>
  <p style="margin: 0 0 4px; line-height: 1.6;">– ruudunlukijaa käyttävä ei saa täyttä hyötyä sivustosta</p>
  <p style="margin: 0 0 4px; line-height: 1.6;">– saavutettavuus ei täytä WCAG-vaatimuksia</p>
  <p style="margin: 0 0 24px; line-height: 1.6;">– voi vaikuttaa myös käytettävyyteen ja konversioon</p>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
  ` : ''}

  <p style="margin: 0 0 20px; line-height: 1.6;">Suurin osa ongelmista on nopeasti korjattavissa — mutta usein ne jäävät tekemättä.</p>

  <p style="margin: 0 0 8px; line-height: 1.6;">Raportissa näkyy myös tarkka kohta sivulla, jossa ongelma esiintyy — löydätte sen liitteenä.</p>

  <p style="margin: 0 0 20px; line-height: 1.6;">Jos haluatte korjaukset tehtyä, auditointi onnistuu nopeasti:</p>

  <a href="${senderUrl}#hinnoittelu" style="display: inline-block; background: #0A2540; color: #ffffff; font-weight: 600; font-size: 15px; padding: 13px 26px; border-radius: 6px; text-decoration: none;">
    Tilaa saavutettavuusauditointi
  </a>

  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 32px 0 24px;">

  <p style="margin: 0 0 8px; line-height: 1.6;">Jos haluatte, voin myös:</p>
  <p style="margin: 0 0 4px; line-height: 1.6;">– korjata nämä suoraan sivustollenne</p>
  <p style="margin: 0 0 20px; line-height: 1.6;">– varmistaa WCAG 2.2 -vaatimusten täyttymisen käytännössä</p>

  <p style="margin: 0 0 32px; line-height: 1.6;">Useimmat auditoinnit jäävät raporttitasolle — minä vien korjaukset tuotantoon.</p>

  <p style="margin: 0 0 32px; line-height: 1.6; color: #475569;">Jos tämä jää korjaamatta, sama ongelma todennäköisesti toistuu myös muilla sivuilla.</p>

  <p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.8;">
    Ystävällisin terveisin,<br>
    <strong style="color: #1a1a1a;">${senderName}</strong><br>
    <a href="${senderUrl}" style="color: #475569;">${senderUrl.replace('https://', '')}</a>
  </p>

</body>
</html>`

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: `Löysimme saavutettavuusongelman sivustoltanne (${subjectIssueLabel})`,
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
