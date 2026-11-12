require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const engine = require('ejs-mate');
const ExpressError = require('./utils/ExpressError');
const inviteRoutes = require('./routes/invites');
const pageRoutes = require('./routes/pages');
const sessionRoutes = require('./routes/sessions');
const dashboardRoutes = require('./routes/dashboard');
const { initializeSockets } = require('./server/socket');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 1009;

app.engine('ejs', engine);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', pageRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/', dashboardRoutes);

app.use((req, _res, next) => next(new ExpressError(404, 'Page not found.')));
app.use((error, req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const message = statusCode === 500 ? 'Something went wrong.' : error.message;
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(statusCode).json({ error: message });
  }
  return res.status(statusCode).render('err', { statusCode, message });
});

initializeSockets(server);

async function start() {
  const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/kycshield';
  await mongoose.connect(MONGO_URL);
  server.listen(PORT, () => console.log(`KYCShield listening on port ${PORT}`));
}

start().catch(() => {
  console.error('Server startup failed. Check the local MongoDB service and .env configuration.');
  process.exit(1);
});
