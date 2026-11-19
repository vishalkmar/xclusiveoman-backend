// Readable URLs: the frontend appends a human-readable name after a resource
// id so the network tab reads
//   /admin/fd-packages/281b2d7a-…/goa-4n-getaway
//   /departures/281b2d7a-…/goa-4n-getaway
// instead of a bare uuid. The name is purely cosmetic — this strips it before
// routing, so every route keeps matching on `/:id` and a renamed resource (or
// a stale link) can never 404 over its name.
//
// A trailing segment is only stripped when it is not the name of a real
// sub-route (…/:id/images, …/:id/itinerary, …), which is collected from the
// router itself on the first request so it can't drift from the routes.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// /<resource>[/<sub-resource>[/<sub-resource>]]/<uuid>/<name> — the name
// follows a resource id (admin and agent routes alike).
const READABLE = new RegExp(`^(/[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*){0,2}/${UUID})/([^/]+)$`, 'i');

function collectSubRouteNames(stack, out) {
  for (const layer of stack || []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        const m = p.match(/\/:[^/]+\/([^/:]+)$/);
        if (m) out.add(m[1].toLowerCase());
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      collectSubRouteNames(layer.handle.stack, out);
    }
  }
}

function readablePath(router) {
  let reserved = null;
  return function readablePathMiddleware(req, res, next) {
    const queryAt = req.url.indexOf('?');
    const pathname = queryAt === -1 ? req.url : req.url.slice(0, queryAt);
    const m = pathname.match(READABLE);
    if (m) {
      if (!reserved) {
        reserved = new Set();
        collectSubRouteNames(router.stack, reserved);
      }
      if (!reserved.has(m[2].toLowerCase())) {
        req.url = m[1] + (queryAt === -1 ? '' : req.url.slice(queryAt));
      }
    }
    next();
  };
}

module.exports.readablePath = readablePath;
