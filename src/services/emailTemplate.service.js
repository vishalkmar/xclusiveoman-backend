const {
  env
} = require('../config/env.js');

const {
  formatMoney
} = require('../utils/currency.js');

// Marketing Center (email channel) — a branded HTML wrapper for the plain
// subject/body an admin composes in Compose's Message card (there's no rich
// text editor there, only a Textarea). Previously every marketing email
// (Send Test and Send Campaign — marketingSend.service.js /
// marketing.controller.js) went out as unstyled plain text; this is the
// first HTML template anywhere in the backend, so it's kept generic/
// reusable (not Marketing-specific in its own code) even though today only
// Marketing's two send paths call it.

// The logo is linked by absolute URL (env.emailLogoUrl, served from
// src/assets by app.js), not attached and inlined. Brevo can't send cid:
// inline images, and the base64 data-URI fallback email.service.js used
// instead rendered as a broken image in Gmail (which blocks data: images)
// and, at ~210KB of base64, pushed every branded email past Gmail's ~102KB
// clipping limit ("[Message clipped]").
function renderLogo() {
  return `<img src="${escapeHtml(env.emailLogoUrl)}" alt="Xclusive Oman" width="150" style="display:block; height:auto; border:0; max-width:150px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:700;" />`;
}

// Same brand tokens as the admin/agent frontends' own Tailwind config
// (tailwind.config.js: ink #16233f, accent #d1642f, accent-soft #fbe1cf) —
// a branded email should read as the same product, not a mismatched
// one-off palette invented just for this template.
const INK = '#16233f';
const ACCENT = '#d1642f';
const ACCENT_SOFT = '#fbe1cf';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Task 11 (Open & Click Tracking) — Compose's Message body has no rich text
// editor, so a URL an admin types is otherwise just escaped plain text,
// never a real, clickable link; without auto-linkifying it first, click
// tracking would have nothing to ever track for a real campaign. Matches
// bare http(s) URLs and trims a handful of common trailing
// sentence/closing punctuation characters that would otherwise get pulled
// into the link target (e.g. "see https://x.com." shouldn't link to
// "https://x.com.").
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunctuation(url) {
  return url.replace(TRAILING_PUNCTUATION, '');
}

// A marker unlikely to ever occur naturally in an admin-typed message and,
// being plain letters/digits, passes through escapeHtml() completely
// unchanged — so it survives the paragraph-building pass below intact and
// can be swapped for a real anchor tag afterward, without needing to touch
// (or re-parse) already-escaped HTML.
function linkToken(index) {
  return `##XCLTRACKLINK${index}##`;
}

// Finds every URL in the raw body text (before any HTML escaping) and
// replaces each with a numbered token; `links[i]` is the real destination
// for `linkToken(i)`. Kept as its own pass over the *whole* body (not
// per-paragraph) so link numbering stays correct across paragraph breaks.
function extractLinks(bodyText) {
  const links = [];
  const tokenized = String(bodyText || '').replace(URL_PATTERN, (rawUrl) => {
    links.push(stripTrailingPunctuation(rawUrl));
    return linkToken(links.length - 1);
  });
  return { tokenized, links };
}

// Compose's Message body (already link-tokenized above) -> safe HTML: one
// <p> per blank-line-separated block, single line breaks within a block
// preserved as <br>. The raw string (aside from the link tokens, which are
// plain alphanumerics) is never trusted as HTML; every character is
// escaped before any tag goes around it, so a body containing "<" or "&"
// (or an attempted script tag) can never alter the template's markup.
function textToHtmlParagraphs(tokenizedText) {
  const blocks = tokenizedText.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return '';
  return blocks
    .map(
      (block) =>
        `<p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`
    )
    .join('');
}

// Turns each `##XCLTRACKLINKn##` token left over from extractLinks/
// textToHtmlParagraphs above into a real anchor tag — `{{TRACK_LINK_n}}` is
// left as the `href` placeholder, resolved per-recipient afterward by
// resolveTrackedLinks() below (Send Campaign) or straight to the real URL
// (Send Test, which has no recipient to track — see marketing.controller.js
// #sendTest's own comment).
function insertLinkAnchors(html, links) {
  return html.replace(/##XCLTRACKLINK(\d+)##/g, (_, idxStr) => {
    const idx = Number(idxStr);
    const url = links[idx];
    if (url === undefined) return '';
    return `<a href="{{TRACK_LINK_${idx}}}" style="color:${ACCENT}; text-decoration:underline;">${escapeHtml(url)}</a>`;
  });
}

function buildMarketingEmailHtml({ subject, bodyText }) {
  const { tokenized, links } = extractLinks(bodyText);
  const bodyHtml = insertLinkAnchors(textToHtmlParagraphs(tokenized), links);

  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#f4f4f2;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid ${BORDER};">
            <tr>
              <td style="background:${INK}; padding:24px 32px;">
                ${renderLogo()}
              </td>
            </tr>
            <tr>
              <td style="height:4px; background:${ACCENT}; line-height:4px; font-size:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px; font-family:Arial, Helvetica, sans-serif;">
                ${subject ? `<h1 style="margin:0 0 20px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(subject)}</h1>` : ''}
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background:${ACCENT_SOFT};">
                <p style="margin:0; font-size:11px; line-height:1.6; color:${MUTED}; font-family:Arial, Helvetica, sans-serif;">
                  Xclusive Oman — B2B &amp; MICE Trade Portal. This message was sent to you as a registered Xclusive Oman trade partner.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { html, attachments: [], links };
}

module.exports.buildMarketingEmailHtml = buildMarketingEmailHtml;

// Small transactional template for one-to-one admin messages. It deliberately
// avoids inline CID images: some Gmail clients clip or hide the message body
// when a transactional email contains the larger marketing image payload.
function buildAgentMessageEmailHtml({ subject, bodyText }) {
  const body = String(bodyText || '')
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p style="margin:0 0 16px; font:14px/1.6 Arial,Helvetica,sans-serif;color:${INK};">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f7ff;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};"><tr><td style="padding:20px 28px;background:${INK};font:700 18px Arial,Helvetica,sans-serif;color:#fff;">Xclusive Oman</td></tr><tr><td style="height:4px;background:${ACCENT};font-size:0;line-height:4px;">&nbsp;</td></tr><tr><td style="padding:28px;">${subject ? `<h1 style="margin:0 0 20px;font:700 21px/1.35 Arial,Helvetica,sans-serif;color:${INK};">${escapeHtml(subject)}</h1>` : ''}${body || '<p style="font:14px Arial,Helvetica,sans-serif;color:' + MUTED + ';">No message content.</p>'}</td></tr><tr><td style="padding:16px 28px;background:${ACCENT_SOFT};font:11px/1.5 Arial,Helvetica,sans-serif;color:${MUTED};">Xclusive Oman — B2B &amp; MICE Trade Portal.</td></tr></table></td></tr></table></body></html>`;
}

module.exports.buildAgentMessageEmailHtml = buildAgentMessageEmailHtml;

function resolveTrackedLinks(html, links, resolveUrl) {
  let out = html;
  links.forEach((url, index) => {
    out = out.split(`{{TRACK_LINK_${index}}}`).join(resolveUrl(url, index));
  });
  return out;
}

module.exports.resolveTrackedLinks = resolveTrackedLinks;

// `heading`/`intro` default to the plain sign-in wording; the admin
// console's email second factor (adminEmailMfa.service.js) passes its own
// for the setup/turn-off confirmations.
function buildOtpEmailHtml({
  otp,
  expiresInMinutes,
  heading = 'Your sign-in code',
  intro = 'Enter this code to finish signing in to Xclusive Oman.',
}) {
  const digits = escapeHtml(otp);
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#f4f4f2;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid ${BORDER};">
            <tr>
              <td style="background:${INK}; padding:20px 32px;">
                <span style="font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:700; color:#ffffff; letter-spacing:0.02em;">Xclusive Oman</span>
              </td>
            </tr>
            <tr>
              <td style="height:4px; background:${ACCENT}; line-height:4px; font-size:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px; font-family:Arial, Helvetica, sans-serif; text-align:center;">
                <h1 style="margin:0 0 8px; font-size:19px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(heading)}</h1>
                <p style="margin:0 0 24px; font-size:13px; line-height:1.6; color:${MUTED};">${escapeHtml(intro)}</p>
                <div style="margin:0 auto 24px; display:inline-block; padding:16px 28px; background:${ACCENT_SOFT}; border:1px solid ${ACCENT}; border-radius:8px;">
                  <span style="font-family:'SFMono-Regular', Consolas, monospace; font-size:34px; font-weight:700; letter-spacing:10px; color:${INK};">${digits}</span>
                </div>
                <p style="margin:0; font-size:12px; line-height:1.6; color:${MUTED};">This code expires in ${expiresInMinutes} minutes.<br>If you didn't request this, you can safely ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background:${ACCENT_SOFT};">
                <p style="margin:0; font-size:11px; line-height:1.6; color:${MUTED}; font-family:Arial, Helvetica, sans-serif;">
                  Xclusive Oman — B2B &amp; MICE Trade Portal. This message was sent to you as a registered Xclusive Oman trade partner.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { html, attachments: [] };
}

module.exports.buildOtpEmailHtml = buildOtpEmailHtml;

// Shared table-based/inline-styles shell (logo header, accent divider,
// ACCENT_SOFT footer) for the account-lifecycle emails below (staff
// welcome, agent registration-received/approved) — the same visual
// language buildOtpEmailHtml already established, factored out here rather
// than duplicated three more times. buildOtpEmailHtml/buildMarketingEmailHtml
// above predate this and are left as their own inline copies rather than
// migrated onto it, to avoid touching already-shipped, working templates.
function renderBrandedEmailShell({ bodyHtml, width = 480 }) {
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#f4f4f2;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="${width}" cellpadding="0" cellspacing="0" style="max-width:${width}px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid ${BORDER};">
            <tr>
              <td style="background:${INK}; padding:24px 32px;">
                ${renderLogo()}
              </td>
            </tr>
            <tr>
              <td style="height:4px; background:${ACCENT}; line-height:4px; font-size:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px; font-family:Arial, Helvetica, sans-serif;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background:${ACCENT_SOFT};">
                <p style="margin:0; font-size:11px; line-height:1.6; color:${MUTED}; font-family:Arial, Helvetica, sans-serif;">
                  Xclusive Oman — B2B &amp; MICE Trade Portal. This message was sent to you as a registered Xclusive Oman trade partner.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Kept so every builder still returns { html, attachments } — the logo is
// a linked image now (renderLogo), so there's nothing to attach.
function brandedEmailAttachments() {
  return [];
}

// A single, brand-accent CTA button — same ACCENT used for the divider
// stripe/links throughout these templates, white label text for contrast.
function renderEmailButton(label, href) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block; margin-top:4px; padding:12px 28px; background:${ACCENT}; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:14px; font-weight:700; text-decoration:none; border-radius:6px;">${escapeHtml(label)}</a>`;
}

function buildStaffWelcomeEmailHtml(
  { fullName, roleLabel, email, loginUrl, ctaLabel = 'Sign in to the Admin Console' }
) {
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Welcome to Xclusive Oman, ${escapeHtml(fullName)}</h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      You've been added to the Xclusive Oman B2B &amp; MICE Trade Portal as a <strong>${escapeHtml(roleLabel)}</strong>.
    </p>
    <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:${INK};">
      Sign in anytime with your work email — <strong>${escapeHtml(email)}</strong> — there's no password to set: we'll email you a fresh one-time code each time you sign in.
    </p>
    <p style="margin:0;">${renderEmailButton(ctaLabel, loginUrl)}</p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildStaffWelcomeEmailHtml = buildStaffWelcomeEmailHtml;

// `temporaryPassword`: the generated sign-up password (Xclusive@12345 style).
// It works straight away, like the emailed sign-in code (a pending agency
// sees the limited dashboard until approved), and the email says to change it
// from the Profile.
function buildAgentRegistrationReceivedEmailHtml({ fullName, agencyName, email, temporaryPassword }) {
  const passwordHtml = temporaryPassword
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px; background:${ACCENT_SOFT}; border:1px solid ${ACCENT}; border-radius:8px;">
      <tr>
        <td style="padding:16px 20px; font-family:Arial, Helvetica, sans-serif;">
          <p style="margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:${INK};">Your login details</p>
          <p style="margin:0 0 2px; font-size:13px; line-height:1.6; color:${INK};">Email: <strong>${escapeHtml(email)}</strong></p>
          <p style="margin:0; font-size:13px; line-height:1.6; color:${INK};">Password: <strong style="font-size:16px; letter-spacing:0.02em;">${escapeHtml(temporaryPassword)}</strong></p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px; font-size:13px; line-height:1.6; color:${MUTED};">
      You can sign in with this password on the Agent Portal login ("Sign in with password"), or use an emailed sign-in code instead. For your security, please change it from <strong>Profile &rarr; Change password</strong> after your first sign-in, and keep it private.
    </p>`
    : '';
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Thanks for registering, ${escapeHtml(fullName)}</h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      We've received your registration for <strong>${escapeHtml(agencyName)}</strong> on the Xclusive Oman B2B &amp; MICE Trade Portal.
    </p>
    ${passwordHtml}
    <p style="margin:0; font-size:14px; line-height:1.6; color:${INK};">
      Our team is reviewing your details now. You'll get another email the moment your agency is approved — no action is needed from you in the meantime.
    </p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildAgentRegistrationReceivedEmailHtml = buildAgentRegistrationReceivedEmailHtml;

// "Forgot password" email — one single-use link to the reset page.
function buildPasswordResetEmailHtml({ fullName, resetUrl, expiresMinutes }) {
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Reset your password</h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      Hi ${escapeHtml(fullName || 'there')}, we received a request to reset the password for your Xclusive Oman Agent Portal account.
    </p>
    <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:${INK};">
      This link works once and expires in ${escapeHtml(expiresMinutes)} minutes.
    </p>
    <p style="margin:0 0 24px;">${renderEmailButton('Choose a new password', resetUrl)}</p>
    <p style="margin:0; font-size:12px; line-height:1.6; color:${MUTED};">
      If you didn't ask for this, you can ignore this email — your password stays as it is.
    </p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildPasswordResetEmailHtml = buildPasswordResetEmailHtml;

// Security notice after a password was reset or changed.
function buildPasswordChangedEmailHtml({ fullName }) {
  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Your password was changed</h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      Hi ${escapeHtml(fullName || 'there')}, the password for your Xclusive Oman Agent Portal account was just changed, and you've been signed out of your other devices.
    </p>
    <p style="margin:0; font-size:13px; line-height:1.6; color:${MUTED};">
      If this wasn't you, reset your password straight away using "Forgot password" on the sign-in page, or contact support.
    </p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildPasswordChangedEmailHtml = buildPasswordChangedEmailHtml;

function buildAgentApprovedEmailHtml({ fullName, agencyName, loginUrl, rm }) {
  const rmCardHtml = rm
    ? `
    <div style="margin:0 0 24px; padding:16px 20px; background:${ACCENT_SOFT}; border:1px solid ${ACCENT}; border-radius:8px;">
      <p style="margin:0 0 6px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Your Relationship Manager</p>
      <p style="margin:0 0 2px; font-size:14px; line-height:1.5; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(rm.fullName)}</p>
      <p style="margin:0; font-size:13px; line-height:1.5; color:${MUTED}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(rm.email)}${rm.phone ? ` &middot; ${escapeHtml(rm.phone)}` : ''}</p>
    </div>
  `
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">You're approved, ${escapeHtml(fullName)}</h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      Good news — <strong>${escapeHtml(agencyName)}</strong> has been approved on the Xclusive Oman B2B &amp; MICE Trade Portal.
    </p>
    ${rmCardHtml}
    <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:${INK};">
      You can sign in now and start building FIT itineraries, booking Fixed Group Departures, and requesting MICE proposals.
    </p>
    <p style="margin:0;">${renderEmailButton('Sign in to the Agent Portal', loginUrl)}</p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildAgentApprovedEmailHtml = buildAgentApprovedEmailHtml;

// Balance Due Reminder cron (jobs/balanceDueReminder.job.js) — one reminder
// email per transactions row flagged `reminder = true` (a payment that left
// a balance still owed — see payments.model.js#insertTransaction/
// listTransactionsNeedingReminder for exactly what triggers this, not a
// date-proximity check). `overdue` only affects headline/tone (balance_due_date
// already passed, vs. no known date issue yet); balanceDueDate itself can be
// null — a manually-created booking isn't guaranteed to have one set.
function buildBalanceDueReminderEmailHtml({ fullName, packageTitle, balanceDue, balanceDueDate, overdue, loginUrl }) {
  const formattedAmount = formatMoney(balanceDue);
  const formattedDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">
      ${overdue ? 'Payment overdue' : 'Balance payment due'}
    </h1>
    <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK};">
      Hi ${escapeHtml(fullName)}, there's still a balance owed on <strong>${escapeHtml(packageTitle)}</strong>${
    formattedDate
      ? overdue
        ? ` — it was due on <strong>${formattedDate}</strong> and hasn't been settled yet.`
        : ` — due on <strong>${formattedDate}</strong>.`
      : '.'
  }
    </p>
    <div style="margin:0 0 24px; padding:16px 20px; background:${ACCENT_SOFT}; border:1px solid ${ACCENT}; border-radius:8px;">
      <p style="margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:${INK}; font-family:Arial, Helvetica, sans-serif;">Amount due</p>
      <p style="margin:0; font-size:24px; font-weight:700; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${formattedAmount}</p>
    </div>
    <p style="margin:0 0 24px; font-size:14px; line-height:1.6; color:${INK};">
      Settle it from the Payment &amp; Transaction History page in your Agent Portal to avoid any disruption to this booking.
    </p>
    <p style="margin:0;">${renderEmailButton('Go to Payment & Transaction History', loginUrl)}</p>
  `;
  return { html: renderBrandedEmailShell({ bodyHtml }), attachments: brandedEmailAttachments() };
}

module.exports.buildBalanceDueReminderEmailHtml = buildBalanceDueReminderEmailHtml;

// Generic branded notification — every transactional email that used to go
// out as bare plain text (payment received, NEFT rejected, booking created,
// documents ready, FD driver/tour updates). Money values passed in should
// already be formatMoney()-formatted (OMR).
//   highlight — optional { label, value } shown large in the accent card
//   details   — optional [{ label, value }] rows; falsy values are skipped
//   paragraphs — plain-text strings, escaped; line breaks become <br>
function buildNotificationEmailHtml({ heading, paragraphs = [], highlight, details = [], ctaLabel, ctaUrl, width = 520 }) {
  const paragraphHtml = paragraphs
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`
    )
    .join('');

  const highlightHtml = highlight
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px; background:${ACCENT_SOFT}; border:1px solid ${ACCENT}; border-radius:8px;">
      <tr>
        <td style="padding:16px 20px; font-family:Arial, Helvetica, sans-serif;">
          <p style="margin:0 0 4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:${INK};">${escapeHtml(highlight.label)}</p>
          <p style="margin:0; font-size:24px; font-weight:700; color:${INK};">${escapeHtml(highlight.value)}</p>
        </td>
      </tr>
    </table>`
    : '';

  const rows = details.filter((d) => d && d.value !== undefined && d.value !== null && d.value !== '');
  const detailsHtml = rows.length
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px; border-collapse:collapse;">
      ${rows
        .map(
          (d) => `
      <tr>
        <td style="padding:8px 12px 8px 0; border-bottom:1px solid ${BORDER}; font-size:13px; line-height:1.5; color:${MUTED}; font-family:Arial, Helvetica, sans-serif; vertical-align:top; width:40%;">${escapeHtml(d.label)}</td>
        <td style="padding:8px 0; border-bottom:1px solid ${BORDER}; font-size:13px; line-height:1.5; color:${INK}; font-family:Arial, Helvetica, sans-serif; font-weight:700; vertical-align:top; word-break:break-word;">${escapeHtml(d.value).replace(/\n/g, '<br>')}</td>
      </tr>`
        )
        .join('')}
    </table>`
    : '';

  const bodyHtml = `
    <h1 style="margin:0 0 12px; font-size:20px; line-height:1.35; color:${INK}; font-family:Arial, Helvetica, sans-serif;">${escapeHtml(heading)}</h1>
    ${paragraphHtml}
    ${highlightHtml}
    ${detailsHtml}
    ${ctaLabel && ctaUrl ? `<p style="margin:0;">${renderEmailButton(ctaLabel, ctaUrl)}</p>` : ''}
  `;
  return { html: renderBrandedEmailShell({ bodyHtml, width }), attachments: brandedEmailAttachments() };
}

module.exports.buildNotificationEmailHtml = buildNotificationEmailHtml;

function appendTrackingPixel(html, pixelUrl) {
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block; border:0;" />`;
  return html.includes('</body>') ? html.replace('</body>', `${pixelTag}</body>`) : `${html}${pixelTag}`;
}

module.exports.appendTrackingPixel = appendTrackingPixel;
