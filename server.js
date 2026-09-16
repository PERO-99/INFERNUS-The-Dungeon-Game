require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Support both JWT_SECRET and SECRET_KEY env var names; fall back to
// a hard-coded dev value so the server still starts locally without .env
const SECRET_KEY =
    process.env.JWT_SECRET ||
    process.env.SECRET_KEY ||
    'infernus_super_secret_key_change_in_production';

// ── CORS ──
// Allow requests from any origin (needed for Netlify functions & local dev).
// Authorization header is sent as a custom header so we must allow it.
app.use(cors({
    origin: true,               // reflect request origin
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));
app.options('/{*path}', cors()); // handle preflight for all routes (Express 5 syntax)

app.use(express.json());

// Serve static files — never cache index.html so clients always get latest
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── DATABASE SETUP (SUPABASE) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
let dbError = null;

if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes('your-project')) {
    // Don't call process.exit — on Netlify that kills the Lambda permanently.
    // Instead flag the error and let route handlers return 503.
    dbError = 'Supabase credentials are missing or invalid. Set SUPABASE_URL and SUPABASE_KEY in your environment variables.';
    console.error('❌ CRITICAL: ' + dbError);
} else {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('⚡ Connected to Supabase Cloud Database.');
}

// Middleware: reject any DB-dependent request when Supabase isn't configured
function requireDB(req, res, next) {
    if (!supabase) {
        return res.status(503).json({ error: 'Database not configured on server. Contact the administrator.' });
    }
    next();
}

// ── AUTH MIDDLEWARE ──
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// ── HELPER: safe JSON parse for game_data ──
function parseGameData(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return {}; }
}

// ── REGISTER ──
app.post('/api/register', requireDB, async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        const { data: existing, error: checkErr } = await supabase
            .from('users')
            .select('id')
            .ilike('username', username)
            .maybeSingle();

        if (checkErr && checkErr.code !== 'PGRST116') {
            console.error('Supabase check error:', checkErr);
        }
        if (existing) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        const { data: newUser, error: insertErr } = await supabase
            .from('users')
            .insert([{ username, password: hashedPassword, game_data: {} }])
            .select('id, username')
            .single();

        if (insertErr) {
            console.error('Supabase insert error:', insertErr);
            if (insertErr.code === '23505') {
                return res.status(400).json({ error: 'Username already exists' });
            }
            return res.status(500).json({ error: 'Database error during registration' });
        }

        const token = jwt.sign(
            { id: newUser.id, username: newUser.username },
            SECRET_KEY,
            { expiresIn: '7d' }
        );
        return res.json({ message: 'User registered successfully', token, game_data: {} });

    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// ── LOGIN ──
app.post('/api/login', requireDB, async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const { data: user, error: fetchErr } = await supabase
            .from('users')
            .select('*')
            .ilike('username', username)
            .maybeSingle();

        if (fetchErr) {
            console.error('Supabase login fetch error:', fetchErr);
            return res.status(500).json({ error: 'Database error during login' });
        }
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username },
            SECRET_KEY,
            { expiresIn: '7d' }
        );
        return res.json({
            message: 'Login successful',
            token,
            game_data: parseGameData(user.game_data)
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// ── SAVE ──
app.post('/api/save', requireDB, authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const gameData = req.body.game_data || {};

    try {
        const { error: saveErr } = await supabase
            .from('users')
            .update({
                game_data: gameData,
                updated_at: new Date().toISOString()
            })
            .eq('id', userId);

        if (saveErr) {
            console.error('Supabase save error:', saveErr);
            return res.status(500).json({ error: 'Database error while saving' });
        }
        return res.json({ message: 'Game saved successfully' });

    } catch (error) {
        console.error('Save error:', error);
        res.status(500).json({ error: 'Server error while saving' });
    }
});

// ── LOAD ──
app.get('/api/load', requireDB, authenticateToken, async (req, res) => {
    const userId = req.user.id;

    try {
        const { data: user, error: loadErr } = await supabase
            .from('users')
            .select('game_data')
            .eq('id', userId)
            .maybeSingle();

        if (loadErr) {
            console.error('Supabase load error:', loadErr);
            return res.status(500).json({ error: 'Database error while loading' });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.json({ game_data: parseGameData(user.game_data) });

    } catch (error) {
        console.error('Load error:', error);
        res.status(500).json({ error: 'Server error while loading' });
    }
});

// ── STATUS / HEALTH CHECK ──
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        database: supabase ? 'supabase' : 'disconnected',
        dbError: dbError || undefined,
        timestamp: new Date().toISOString()
    });
});

// ── CATCH-ALL: serve index.html for SPA routes ──
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GLOBAL ERROR HANDLER ──
// Catches any unhandled errors thrown inside route handlers
app.use((err, req, res, _next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'An unexpected server error occurred' });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
module.exports = app;
