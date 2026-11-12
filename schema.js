const Joi = require('joi');

const contact = Joi.string().trim().max(254).required().custom((value, helpers) => {
  const email = Joi.string().email({ tlds: { allow: false } }).validate(value);
  const digits = value.replace(/[\s().-]/g, '').replace(/^\+/, '');
  const phone = /^\+?[\d\s().-]+$/.test(value) && /^\d{7,15}$/.test(digits);
  if (!email.error || phone) return value;
  return helpers.error('any.invalid');
}).messages({ 'any.invalid': 'Enter a valid email address or phone number.' });

const inviteSchema = Joi.object({ contact });
const decisionSchema = Joi.object({
  decision: Joi.string().valid('approved', 'rejected').required()
});
const roomIdParamsSchema = Joi.object({
  roomId: Joi.string().hex().length(12).required()
});

module.exports = { inviteSchema, decisionSchema, roomIdParamsSchema };
