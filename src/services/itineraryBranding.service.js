const {
  findUserById
} = require('../models/users.model.js');

const {
  findAgencyById
} = require('../models/agencies.model.js');

// Who the downloaded itinerary PDF is branded for — the agent who requested
// it (the pdfToken's `sub`) and their agency. The PDF is something the agent
// hands to their own client, so it carries the agency's logo, the agent as
// the "Consultant" with their contact number, and the agency's registration
// number from Sign Up (IATA / GST / Company Registration — agencies.
// license_document_type + license_number). Every field may be null for
// agencies registered before those existed; the document just leaves that
// line out.
async function getItineraryBranding(userId) {
  const user = userId ? await findUserById(userId) : null;
  if (!user) return null;
  const agency = user.agency_id ? await findAgencyById(user.agency_id) : null;
  return {
    consultantName: user.full_name || null,
    phone: user.phone || null,
    email: user.email || null,
    agencyName: agency?.name || null,
    logoUrl: agency?.logo_asset_url || null,
    registrationType: agency?.license_document_type || null,
    registrationNumber: agency?.license_number || null,
  };
}

module.exports.getItineraryBranding = getItineraryBranding;
