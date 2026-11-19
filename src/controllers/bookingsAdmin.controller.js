const {
  listBookingsForAdmin,
  listBookingFilterOptions
} = require('../models/bookingsAdmin.model.js');

const {
  findFdPackageById,
  findDepartureDateById
} = require('../models/fdPackages.model.js');

const {
  findAgencyById,
  listAgenciesByRmIds
} = require('../models/agencies.model.js');

const {
  listAgencyOwnerEmails
} = require('../models/users.model.js');

const {
  createFdBooking
} = require('../services/booking.service.js');

const {
  insertAuditLog
} = require('../models/auditLogs.model.js');

const {
  createNotification
} = require('../services/notification.service.js');

const {
  sendEmail
} = require('../services/email.service.js');

const {
  buildNotificationEmailHtml
} = require('../services/emailTemplate.service.js');

const {
  env
} = require('../config/env.js');

const {
  formatMoney
} = require('../utils/currency.js');

const {
  getIo
} = require('../sockets/index.js');

// Admin Bookings & Documents — Manual Booking Flow (Task 13 — Screen 22).
// FD-only; see booking.service.js and bookingsAdmin.model.js for the shared
// scoping rationale. Booking creation itself is NOT reimplemented here —
// every rule this controller enforces (agency approved, package published,
// departure belongs to package) is *admin-specific* validation layered on
// top of the one real transaction, services/booking.service.js#createFdBooking,
// which both this controller and the agent's departures.controller.js call.

function toPublicBooking(b) {
  return {
    id: b.id,
    agencyId: b.agency_id,
    agencyName: b.agency_name,
    fdPackageId: b.fd_package_id,
    packageTitle: b.package_title,
    departureDate: b.departure_date,
    departureLocation: b.departure_location,
    pax: b.pax,
    totalPrice: Number(b.total_price),
    depositPaid: Number(b.deposit_paid),
    balanceDue: Number(b.balance_due),
    balanceDueDate: b.balance_due_date,
    status: b.status,
    createdVia: b.created_via,
    createdByName: b.created_by_name,
    createdAt: b.created_at,
  };
}

async function listBookings(req, res, next) {
  try {
    const {
      search,
      packageSearch,
      destination,
      packageType,
      status,
      agencyId,
      dateFrom,
      dateTo,
      departureFrom,
      departureTo,
      page,
      pageSize,
    } = req.query;

    // Team Portal Bookings & Docs — a Relationship Manager only ever lists
    // bookings for their own assigned agencies (bookingsAdmin.routes.js's
    // scopeToOwnAgencyBooking does the same for the :id detail routes).
    let agencyIds;
    if (req.user.role === 'relationship_manager') {
      const own = await listAgenciesByRmIds([req.user.id]);
      agencyIds = own.map((a) => a.id);
      if (agencyIds.length === 0) {
        return res.json({ bookings: [], pagination: { total: 0, page: 1, pageSize: Number(pageSize) || 20, totalPages: 1 } });
      }
    }

    const { rows, total, page: currentPage, pageSize: limit } = await listBookingsForAdmin({
      search,
      packageSearch,
      destination,
      packageType,
      status,
      agencyId,
      agencyIds,
      dateFrom,
      dateTo,
      departureFrom,
      departureTo,
      page,
      pageSize,
    });

    res.json({
      bookings: rows.map(toPublicBooking),
      pagination: { total, page: currentPage, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.listBookings = listBookings;

// Destination / Package Type options for the admin Package tab's filters —
// same Relationship Manager scoping as listBookings above.
async function getFilterOptions(req, res, next) {
  try {
    let agencyIds;
    if (req.user.role === 'relationship_manager') {
      const own = await listAgenciesByRmIds([req.user.id]);
      agencyIds = own.map((a) => a.id);
      if (agencyIds.length === 0) return res.json({ destinations: [], packageTypes: [] });
    }
    res.json(await listBookingFilterOptions({ agencyIds }));
  } catch (err) {
    next(err);
  }
}

module.exports.getFilterOptions = getFilterOptions;

async function createManualBooking(req, res, next) {
  try {
    const { agencyId, fdPackageId, departureDateId, pax, travelers, addonIds, agreedTotalPrice, depositPaid, paymentMethod } =
      req.body;

    const agency = await findAgencyById(agencyId);
    if (!agency) return res.status(404).json({ error: 'agency_not_found' });
    if (agency.status !== 'approved') {
      return res.status(400).json({ error: 'agency_not_approved', message: 'Only approved agencies can be booked for.' });
    }

    // Team Portal Bookings & Docs — a Relationship Manager may only book on
    // behalf of their own assigned agencies, same scoping as listBookings/
    // scopeToOwnAgencyBooking above.
    if (req.user.role === 'relationship_manager' && agency.rm_user_id !== req.user.id) {
      return res.status(403).json({ error: 'forbidden', message: 'This agency is not assigned to you.' });
    }

    const fdPackage = await findFdPackageById(fdPackageId);
    if (!fdPackage) return res.status(404).json({ error: 'package_not_found' });
    if (fdPackage.status !== 'published') {
      return res.status(400).json({ error: 'package_not_published', message: 'Only published FD packages can be booked.' });
    }

    const departureDate = await findDepartureDateById(departureDateId);
    if (!departureDate || departureDate.fd_package_id !== fdPackage.id) {
      return res.status(400).json({ error: 'invalid_departure_date' });
    }

    // Throws a 409 (seats_unavailable) if the departure is full — no
    // waitlisted booking is created.
    const { booking } = await createFdBooking({
      fdPackage,
      departureDate,
      agencyId: agency.id,
      createdByUserId: req.user.id,
      createdVia: 'manual_admin',
      pax,
      addonIds,
      travelers,
      agreedTotalPrice,
      depositPaid,
    });

    // Same event self-service already emits on creation — an admin-created
    // booking is a real booking the instant it exists, so the agency's own
    // live session (if any) sees it exactly the same way.
    getIo()?.to(`agency:${agency.id}`).emit('booking:status_changed', {
      bookingId: booking.id,
      status: booking.status,
    });

    // One audit entry for the creation event itself — no prior "old" state
    // to diff against (unlike Task 12's stage advances), so field/oldValue
    // stay null and newValue carries everything worth remembering about how
    // this booking came to exist, including the informational payment
    // method (see manualBookingSchema's own comment on why that never
    // becomes a real payments row).
    await insertAuditLog({
      actorUserId: req.user.id,
      entity: 'booking',
      entityId: booking.id,
      field: null,
      oldValue: null,
      newValue: {
        createdVia: 'manual_admin',
        agencyId: agency.id,
        pax,
        totalPrice: Number(booking.total_price),
        depositPaid: Number(booking.deposit_paid),
        status: booking.status,
        paymentMethod: paymentMethod || null,
      },
    });

    // Best-effort, matching fdOperationsNotify.service.js's own posture —
    // the booking has already been durably created by this point, so a
    // notification/email hiccup must never surface as a failure of the
    // booking creation itself.
    try {
      const [owner] = await listAgencyOwnerEmails([agency.id]);
      if (owner) {
        const message = `A booking for ${fdPackage.title} (${pax} pax) was created on your agency's behalf. Status: ${booking.status.replace(/_/g, ' ')}.`;
        try {
          await createNotification({
            recipientUserId: owner.id,
            recipientRole: 'agency_owner',
            type: 'booking_created_manual',
            title: 'Booking created',
            message,
            referenceType: 'booking',
            referenceId: booking.id,
          });
        } catch (err) {
          console.error(`[bookingsAdmin] Failed to notify user ${owner.id}`, err);
        }
        try {
          const bookingUrl = `${env.agentPortalUrl}/bookings/${booking.id}`;
          const { html, attachments } = buildNotificationEmailHtml({
            heading: 'Booking created',
            paragraphs: [`Hi ${owner.full_name || 'there'},`, message],
            details: [
              { label: 'Package', value: fdPackage.title },
              { label: 'Travellers', value: `${pax} pax` },
              { label: 'Total booking value', value: formatMoney(booking.total_price) },
              { label: 'Paid so far', value: formatMoney(booking.deposit_paid) },
              {
                label: 'Status',
                value: booking.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
              },
            ],
            ctaLabel: 'View booking',
            ctaUrl: bookingUrl,
          });
          await sendEmail({
            to: owner.email,
            subject: 'Booking created — Xclusive Oman',
            text: `${message} Total: ${formatMoney(booking.total_price)}. View it at ${bookingUrl}`,
            html,
            attachments,
          });
        } catch (err) {
          console.error(`[bookingsAdmin] Failed to email ${owner.email}`, err);
        }
      }
    } catch (err) {
      console.error(`[bookingsAdmin] Failed to fan out notification for booking ${booking.id}`, err);
    }

    res.status(201).json({
      booking: {
        id: booking.id,
        status: booking.status,
        pax: booking.pax,
        totalPrice: Number(booking.total_price),
        depositPaid: Number(booking.deposit_paid),
        balanceDue: Number(booking.balance_due),
        balanceDueDate: booking.balance_due_date,
        createdVia: booking.created_via,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports.createManualBooking = createManualBooking;
