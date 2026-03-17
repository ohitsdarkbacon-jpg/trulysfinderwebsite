require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { PrismaClient } = require('@prisma/client');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');

const app = express();
const prisma = new PrismaClient();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session store using Postgres
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'super-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Luarmor helper
async function callLuarmor(method, endpoint, body = {}) {
  const url = `https://api.luarmor.net/v3/projects/${process.env.LUARMOR_PROJECT_ID}${endpoint}`;
  try {
    const res = await axios({
      method,
      url,
      headers: {
        Authorization: process.env.LUARMOR_API_KEY,
        'Content-Type': 'application/json'
      },
      data: body
    });
    return res.data;
  } catch (err) {
    console.error('Luarmor API error:', err.response?.data || err.message);
    throw err;
  }
}

// Login protection
app.use((req, res, next) => {
  if (req.path === '/' || req.path.startsWith('/login') || req.path.startsWith('/auth/callback')) return next();
  if (!req.session.user) return res.redirect('/login');
  next();
});

// Discord login routes (same as before)
app.get('/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/login');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    let user = await prisma.user.findUnique({ where: { discordId: userRes.data.id } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          discordId: userRes.data.id,
          username: userRes.data.username || userRes.data.global_name || 'UnknownUser'
        }
      });
    }

    req.session.user = { id: user.id, discordId: user.discordId, username: user.username };
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.redirect('/login');
  }
});

// Dashboard - shows only own slots/keys
app.get('/dashboard', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.user.id },
    include: { slots: { orderBy: { createdAt: 'desc' } } }
  });

  if (!user) return res.redirect('/login');

  const paypalConfigured = !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_SECRET;

  res.render('dashboard', {
    user,
    paypalConfigured,
    ltcWallet: process.env.LTC_WALLET || 'Not set',
    solWallet: process.env.SOL_WALLET || 'Not set'
  });
});

// Helper to generate key on purchase/admin give
async function generateKeyForUser(userId, credits, createdByUsername) {
  const hours = credits * 2;
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { slots: true } });
  if (user.slots.length >= 6) throw new Error('Maximum 6 slots reached');

  const nowUnix = Math.floor(Date.now() / 1000);
  const expiryUnix = nowUnix + (hours * 3600);

  await callLuarmor('POST', '/users', {
    auth_expire: expiryUnix,
    discord_id: user.discordId
  });

  const data = await callLuarmor('GET', '/users');
  const matching = data.users
    ?.filter(u => u.discord_id === user.discordId)
    ?.sort((a, b) => (new Date(b.created_at || 0) - new Date(a.created_at || 0)))[0];

  const key = matching?.key || matching?.user_key;
  if (!key) throw new Error('Failed to get key from Luarmor - check IP whitelist / API key');

  await prisma.slot.create({
    data: {
      key,
      expiry: new Date(expiryUnix * 1000),
      createdByUsername,
      userId
    }
  });

  await prisma.user.update({
    where: { id: userId },
    data: { credits: { increment: credits } }
  });
}

// Example Stripe success (add similar for PayPal, crypto webhook, ticket paid)
app.get('/stripe/success', async (req, res) => {
  try {
    const credits = parseInt(req.query.credits || 0);
    if (credits < 1) throw new Error('Invalid credits amount');
    await generateKeyForUser(req.session.user.id, credits, req.session.user.username);
    res.redirect('/dashboard?success=Your key has been generated! Check your slots below.');
  } catch (err) {
    res.redirect('/dashboard?error=' + encodeURIComponent(err.message));
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', (req, res) => res.render('index'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
});