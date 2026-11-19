-- "Delete package only, keep its bookings" (admin FD package delete): a
-- package with bookings can't simply be removed — bookings, payments,
-- operations records and reviews all point at it or its departure dates. So
-- that option archives the package instead: it disappears from the admin
-- package list and from agents and can't be booked or edited, while the row
-- (with its departure dates and add-ons) stays so every kept booking still
-- shows its package, dates, add-ons and payments, and revenue history is
-- untouched. archived_at records when it happened.
ALTER TABLE fd_packages
  MODIFY COLUMN status ENUM('draft', 'published', 'closed', 'archived') NOT NULL DEFAULT 'draft',
  ADD COLUMN archived_at DATETIME NULL;
