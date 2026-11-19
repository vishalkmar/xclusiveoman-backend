function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
}

module.exports.notFoundHandler = notFoundHandler;

// What gets logged for an error. mysql2 errors carry the full SQL text with
// the bound values already interpolated (`err.sql`) — emails, OTP hashes,
// tokens — so the raw error object is never logged, only these fields.
function loggableError(err, req) {
  return {
    route: `${req.method} ${req.originalUrl.split('?')[0]}`,
    name: err?.name,
    code: err?.code,
    status: err?.status,
    message: err?.message,
    stack: err?.stack,
  };
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Malformed / oversized request bodies (express.json) — the client's
  // fault, answered without a stack trace.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'The request body is too large.' });
  }

  if (err.name === 'MulterError') {
    // Multer's own errors (oversized file, too many files, wrong field
    // name, …) never carry a `.status`; every upload endpoint shares this.
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: 'upload_rejected', message: err.message });
  }

  // MySQL constraint errors (and their Postgres equivalents, from before the
  // database moved to MySQL).
  if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') {
    return res.status(409).json({ error: 'conflict', message: 'Record already exists' });
  }
  if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED' || err.code === '23503') {
    // e.g. deleting an FD package that still has bookings against it.
    return res.status(409).json({ error: 'conflict', message: 'This record is still referenced elsewhere and cannot be deleted.' });
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') {
    return res.status(400).json({ error: 'invalid_reference', message: 'A referenced record does not exist.' });
  }

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[error]', loggableError(err, req));

  // Only errors this codebase raised on purpose (they set `.status`) say
  // what went wrong; anything unexpected gets a generic message so stack
  // traces, SQL and internal paths never reach the client.
  res.status(status).json({
    error: err.publicCode || (status >= 500 ? 'internal_error' : 'request_error'),
    message: status === 500 ? 'Something went wrong' : err.message,
  });
}

module.exports.errorHandler = errorHandler;
