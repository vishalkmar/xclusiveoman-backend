const {
  pool
} = require('../db/pool.js');

const {
  newId
} = require('../utils/id.js');

const POLICY_COLUMNS = {
  terms: 'terms_html',
  privacy: 'privacy_html',
  disclaimer: 'disclaimer_html',
  refund: 'refund_html',
};

function policyColumn(policy = 'terms') {
  return POLICY_COLUMNS[policy] || null;
}

const siteTermsModel = {
  async get(policy = 'terms') {
    const column = policyColumn(policy);
    if (!column) return null;
    const { rows } = await pool.query(
      `SELECT id, ${column} AS body_html, created_at, updated_at
       FROM site_terms ORDER BY created_at ASC LIMIT 1`
    );
    return rows[0] || null;
  },

  // Creates the one row on the first save, patches it in place on every
  // save after that — same "create it if nothing exists yet, otherwise
  // update it" flow ProductCatalog.jsx's own VisaForm/MealForm already use
  // client-side, just done here in one round trip instead of the frontend
  // having to know which one to call.
  async upsert(policy, bodyHtml) {
    const column = policyColumn(policy);
    if (!column) throw new Error('Unsupported site policy');
    const existing = await this.get(policy);
    if (existing) {
      await pool.query(
        `UPDATE site_terms SET ${column} = ?, updated_at = now() WHERE id = ?`,
        [bodyHtml, existing.id]
      );
      return this.get(policy);
    }
    const id = newId();
    await pool.query(`INSERT INTO site_terms (id, ${column}) VALUES (?, ?)`, [id, bodyHtml]);
    return this.get(policy);
  },
};

module.exports.siteTermsModel = siteTermsModel;
