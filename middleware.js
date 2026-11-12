const ExpressError = require('./utils/ExpressError');
const crypto = require('crypto');
const { inviteSchema, decisionSchema, roomIdParamsSchema, feedbackSchema } = require('./schema');

let authWarningPrinted = false;

function validate(schema, source, assignTo) {
  return function validateRequest(req, _res, next) {
    const { error, value } = schema.validate(req[source], { abortEarly: true, stripUnknown: true });
    if (error) return next(new ExpressError(400, error.details[0].message));
    req[assignTo] = value;
    return next();
  };
}

function safeEqual(value, expected) {
  const received = Buffer.from(value);
  const configured = Buffer.from(expected);
  const length = Math.max(received.length, configured.length, 1);
  const receivedPadded = Buffer.alloc(length);
  const configuredPadded = Buffer.alloc(length);
  received.copy(receivedPadded);
  configured.copy(configuredPadded);
  const matches = crypto.timingSafeEqual(receivedPadded, configuredPadded);
  return matches && received.length === configured.length;
}

function basicAuth(req, res, next) {
  const username = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASS;
  if (!username && !password) {
    if (!authWarningPrinted) {
      console.warn('KYCShield analyst routes are unprotected because DASHBOARD_USER and DASHBOARD_PASS are unset.');
      authWarningPrinted = true;
    }
    return next();
  }
  if (!username || !password) {
    return res.status(503).send('Dashboard authentication is not fully configured.');
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+=*)$/i);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="KYCShield analyst", charset="UTF-8"');
    return res.status(401).send('Analyst credentials are required.');
  }

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch (_error) {
    decoded = '';
  }
  const separator = decoded.indexOf(':');
  const receivedUser = separator < 0 ? '' : decoded.slice(0, separator);
  const receivedPass = separator < 0 ? '' : decoded.slice(separator + 1);
  const usernameMatches = safeEqual(receivedUser, username);
  const passwordMatches = safeEqual(receivedPass, password);
  if (!(usernameMatches && passwordMatches)) {
    res.set('WWW-Authenticate', 'Basic realm="KYCShield analyst", charset="UTF-8"');
    return res.status(401).send('Analyst credentials are invalid.');
  }
  return next();
}

module.exports = {
  validateInvite: validate(inviteSchema, 'body', 'validatedBody'),
  validateDecision: validate(decisionSchema, 'body', 'validatedBody'),
  validateRoomId: validate(roomIdParamsSchema, 'params', 'validatedParams'),
  validateFeedback: validate(feedbackSchema, 'body', 'validatedBody'),
  basicAuth
};
