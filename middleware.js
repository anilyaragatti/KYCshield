const ExpressError = require('./utils/ExpressError');
const { inviteSchema, decisionSchema, roomIdParamsSchema } = require('./schema');

function validate(schema, source, assignTo) {
  return function validateRequest(req, _res, next) {
    const { error, value } = schema.validate(req[source], { abortEarly: true, stripUnknown: true });
    if (error) return next(new ExpressError(400, error.details[0].message));
    req[assignTo] = value;
    return next();
  };
}

module.exports = {
  validateInvite: validate(inviteSchema, 'body', 'validatedBody'),
  validateDecision: validate(decisionSchema, 'body', 'validatedBody'),
  validateRoomId: validate(roomIdParamsSchema, 'params', 'validatedParams')
};
