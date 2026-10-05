// 邮件发送：Mailgun HTTP API；未配置时退化为控制台打印（开发 / 测试）。设计见 DESIGN.md §14.2
import { HttpError } from './schemas.js';

/** 发信额度用尽（本地每日计数或 Mailgun 拒绝） */
export class MailQuotaError extends Error {}

/**
 * @param {{ apiKey?: string, domain?: string, from?: string, baseUrl?: string }} cfg
 */
export function createMailer({ apiKey, domain, from, baseUrl = 'https://api.mailgun.net' }) {
  if (!apiKey || !domain) {
    return {
      kind: 'console',
      outbox: [],
      async send(msg) {
        this.outbox.push(msg);
        if (this.outbox.length > 100) this.outbox.shift();
        console.log(`[mail:console] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
      },
    };
  }
  const sender = from || `Anotify <noreply@${domain}>`;
  const auth = 'Basic ' + Buffer.from(`api:${apiKey}`).toString('base64');
  return {
    kind: `mailgun ${domain}`,
    async send({ to, subject, text, html }) {
      const form = new URLSearchParams({ from: sender, to, subject, text });
      if (html) form.set('html', html);
      let res;
      try {
        res = await fetch(`${baseUrl}/v3/${domain}/messages`, {
          method: 'POST',
          headers: { authorization: auth },
          body: form,
          signal: AbortSignal.timeout(15000),
        });
      } catch (e) {
        throw new HttpError(502, 'mail_failed', `could not reach the mail service: ${e.message}`);
      }
      if (res.ok) return;
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 免费档每日 100 封：Mailgun 以 429 或带 limit/quota 字样的 4xx 拒绝
      if (res.status === 429 || /limit|quota|exceed/i.test(detail)) {
        throw new MailQuotaError(detail || `HTTP ${res.status}`);
      }
      console.error(`[mail] mailgun HTTP ${res.status}: ${detail}`);
      throw new HttpError(502, 'mail_failed', 'the mail service rejected the message; please try again later');
    },
  };
}

export function verificationEmail({ link, ttlHours }) {
  const subject = 'Verify your Anotify account';
  const text = [
    'Welcome to Anotify!',
    '',
    'Confirm your email address to finish creating your account:',
    link,
    '',
    `This link expires in ${ttlHours} hours. If you did not sign up, ignore this email.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#1d2340;line-height:1.6">
<h2 style="margin:0 0 12px">Welcome to Anotify</h2>
<p>Confirm your email address to finish creating your account:</p>
<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1d2340;color:#fff;border-radius:8px;text-decoration:none">Verify email</a></p>
<p style="font-size:13px;color:#5a6280">Or open this link: <br><a href="${link}">${link}</a></p>
<p style="font-size:13px;color:#5a6280">This link expires in ${ttlHours} hours. If you did not sign up, ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}
