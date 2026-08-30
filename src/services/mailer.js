// Envio de e-mail transacional.
//
// Tres drivers, escolhidos pelo que estiver configurado:
//   resend   RESEND_API_KEY, via HTTP, sem dependencia
//   smtp     SMTP_URL, via nodemailer
//   console  nenhum dos dois: imprime no terminal
//
// O driver "console" NAO e um mock silencioso. Ele diz alto que nao enviou
// nada, a resposta da API marca `entregue: false` com o motivo, e o doctor
// reclama. O que ele evita e travar o desenvolvimento por falta de conta de
// e-mail; o que ele nunca faz e deixar alguem achar que o e-mail saiu.

import { config } from '../config.js'
import { log } from '../lib/logger.js'

const REMETENTE_PADRAO = 'Uni.work <nao-responda@uniwork.local>'

export function driverDeEmail () {
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.SMTP_URL) return 'smtp'
  return 'console'
}

export function remetente () {
  return process.env.EMAIL_REMETENTE || REMETENTE_PADRAO
}

export function emailConfigurado () {
  return driverDeEmail() !== 'console'
}

async function enviarPeloResend ({ para, assunto, html, texto }) {
  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ from: remetente(), to: [para], subject: assunto, html, text: texto })
  })
  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '')
    throw new Error(`Resend respondeu ${resposta.status}: ${corpo.slice(0, 200)}`)
  }
  const dados = await resposta.json().catch(() => ({}))
  return { id: dados.id ?? null }
}

async function enviarPeloSmtp ({ para, assunto, html, texto }) {
  const nodemailer = (await import('nodemailer')).default
  const transporte = nodemailer.createTransport(process.env.SMTP_URL)
  const info = await transporte.sendMail({ from: remetente(), to: para, subject: assunto, html, text: texto })
  return { id: info.messageId ?? null }
}

function imprimirNoTerminal ({ para, assunto, texto }) {
  // lint-permitido: este bloco existe para ser lido por uma pessoa no terminal.
  // Passar por JSON estruturado transformaria o link de acesso numa linha
  // ilegivel, e o objetivo aqui e exatamente que ele seja facil de copiar.
  console.log(`
  ┌─ E-MAIL NAO ENVIADO ────────────────────────────────────────────────────
  │ Nenhum servico de e-mail esta configurado, entao o conteudo abaixo NAO
  │ saiu para lugar nenhum. Configure RESEND_API_KEY ou SMTP_URL no .env.
  │
  │ para:    ${para}
  │ assunto: ${assunto}
  │
${texto.split('\n').map((linha) => `  │ ${linha}`).join('\n')}
  └─────────────────────────────────────────────────────────────────────────
`)
  return { id: null }
}

/**
 * Envia. Devolve sempre o mesmo formato, com `entregue` dizendo a verdade.
 * Nunca lanca: quem chama decide o que fazer com um envio que nao saiu.
 */
export async function enviarEmail ({ para, assunto, html, texto }) {
  const driver = driverDeEmail()
  try {
    if (driver === 'resend') {
      const { id } = await enviarPeloResend({ para, assunto, html, texto })
      return { entregue: true, driver, id, motivo: null }
    }
    if (driver === 'smtp') {
      const { id } = await enviarPeloSmtp({ para, assunto, html, texto })
      return { entregue: true, driver, id, motivo: null }
    }
    imprimirNoTerminal({ para, assunto, texto })
    return {
      entregue: false,
      driver,
      id: null,
      motivo: 'email_nao_configurado',
      explicacao: 'Nenhum servico de e-mail esta configurado neste ambiente.'
    }
  } catch (err) {
    log.error('email_falhou', { driver, detalhe: err.message })
    return { entregue: false, driver, id: null, motivo: 'falha_no_envio', explicacao: err.message }
  }
}

// ─── modelos ─────────────────────────────────────────────────────────────────

function moldura (titulo, corpo) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#000;padding:32px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#0a0a0c;border:1px solid #1e1e24;border-radius:20px;overflow:hidden">
      <tr><td style="height:5px;background:linear-gradient(115deg,#7c5cff,#c04cf0,#ff7a45)"></td></tr>
      <tr><td style="padding:32px">
        <p style="margin:0 0 26px;font-size:13px;font-weight:700;letter-spacing:3px;color:#8b8b96">UNI.WORK</p>
        <h1 style="margin:0 0 14px;font-size:23px;color:#f5f5f7;font-weight:800">${titulo}</h1>
        ${corpo}
      </td></tr>
      <tr><td style="padding:0 32px 30px">
        <p style="margin:0;font-size:12px;color:#6e6e78;line-height:1.6">
          Se voce nao pediu isto, pode ignorar esta mensagem com tranquilidade.
          Ambiente de demonstracao.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`
}

export function modeloMagicLink ({ nome, link, minutos }) {
  const saudacao = nome ? `Oi, ${nome}.` : 'Oi.'
  return {
    assunto: 'Seu link de acesso ao Uni.work',
    texto: `${saudacao}

Use o link abaixo para entrar na sua conta. Ele vale por ${minutos} minutos e
funciona uma vez so.

${link}

Se voce nao pediu isto, pode ignorar esta mensagem.`,
    html: moldura('Seu link de acesso', `
        <p style="margin:0 0 22px;font-size:15px;color:#b9b9c4;line-height:1.6">
          ${saudacao} Toque no botao para entrar. O link vale por
          <strong style="color:#f5f5f7">${minutos} minutos</strong> e funciona uma vez so.
        </p>
        <a href="${link}" style="display:inline-block;padding:13px 28px;border-radius:12px;background:linear-gradient(115deg,#7c5cff,#c04cf0,#ff7a45);color:#000;font-weight:700;text-decoration:none;font-size:15px">
          Entrar na minha conta
        </a>
        <p style="margin:24px 0 0;font-size:12px;color:#6e6e78;word-break:break-all;line-height:1.6">
          Se o botao nao funcionar, cole este endereco no navegador:<br>${link}
        </p>`)
  }
}

export function modeloPagamentoLiberado ({ nome, valor, atividade, horas, linkCertificado }) {
  return {
    assunto: `Pagamento liberado: ${valor}`,
    texto: `Oi, ${nome}.

O contratante confirmou a entrega de "${atividade}".

Pagamento liberado: ${valor}
Certificado emitido: ${horas}h de atividade complementar

Veja o certificado: ${linkCertificado}`,
    html: moldura('Pagamento liberado', `
        <p style="margin:0 0 22px;font-size:15px;color:#b9b9c4;line-height:1.6">
          Oi, ${nome}. O contratante confirmou a entrega de
          <strong style="color:#f5f5f7">${atividade}</strong>.
        </p>
        <table role="presentation" width="100%" style="margin-bottom:24px">
          <tr>
            <td style="padding:16px;background:#121216;border:1px solid #26262e;border-radius:14px" width="50%">
              <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;color:#8b8b96">RECEBIDO</p>
              <p style="margin:0;font-size:24px;font-weight:700;color:#2fd39a">${valor}</p>
            </td>
            <td width="10"></td>
            <td style="padding:16px;background:#121216;border:1px solid #26262e;border-radius:14px" width="50%">
              <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;color:#8b8b96">CERTIFICADO</p>
              <p style="margin:0;font-size:24px;font-weight:700;color:#c04cf0">${horas}h</p>
            </td>
          </tr>
        </table>
        <a href="${linkCertificado}" style="display:inline-block;padding:13px 28px;border-radius:12px;background:#f5f5f7;color:#000;font-weight:700;text-decoration:none;font-size:15px">
          Ver meu certificado
        </a>`)
  }
}

export function modeloGenerico ({ titulo, corpo, link, textoDoBotao = 'Abrir no Uni.work' }) {
  return {
    assunto: titulo,
    texto: `${titulo}\n\n${corpo}\n\n${link ?? ''}`.trim(),
    html: moldura(titulo, `
        <p style="margin:0 0 22px;font-size:15px;color:#b9b9c4;line-height:1.6">${corpo}</p>
        ${link ? `<a href="${link}" style="display:inline-block;padding:13px 28px;border-radius:12px;background:#f5f5f7;color:#000;font-weight:700;text-decoration:none;font-size:15px">${textoDoBotao}</a>` : ''}`)
  }
}
