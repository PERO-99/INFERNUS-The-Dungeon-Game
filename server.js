require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || process.env.SECRET_KEY || 'infernus_super_secret_key_change_in_production';

app.use(cors());
app.use(express.json());
// Serve static files — never cache index.html so mobile gets latest code
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── DATABASE SETUP (SUPABASE ONLY) ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes('your-project')) {
    console.error('❌ CRITICAL ERROR: Supabase credentials missing in environment variables.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log('⚡ Connected to Supabase Cloud Database.');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// ── REGISTER ──
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    
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
            return res.status(500).json({ error: 'Database error: ' + insertErr.message });
        }

        const token = jwt.sign({ id: newUser.id, username: newUser.username }, SECRET_KEY, { expiresIn: '7d' });
        return res.json({ message: 'User registered successfully', token, game_data: {} });

    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

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
            return res.status(500).json({ error: 'Database error' });
        }
        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '7d' });
        const gameData = typeof user.game_data === 'string' ? JSON.parse(user.game_data || '{}') : (user.game_data || {});
        return res.json({ message: 'Login successful', token, game_data: gameData });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── SAVE ──
app.post('/api/save', authenticateToken, async (req, res) => {
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
            return res.status(500).json({ error: 'Database error while saving: ' + saveErr.message });
        }
        return res.json({ message: 'Game saved successfully' });

    } catch (error) {
        console.error('Save error:', error);
        res.status(500).json({ error: 'Server error while saving' });
    }
});

// ── LOAD ──
app.get('/api/load', authenticateToken, async (req, res) => {
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

        const gameData = typeof user.game_data === 'string' ? JSON.parse(user.game_data || '{}') : (user.game_data || {});
        return res.json({ game_data: gameData });

    } catch (error) {
        console.error('Load error:', error);
        res.status(500).json({ error: 'Server error while loading' });
    }
});

// ── STATUS / HEALTH CHECK ──
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        database: 'supabase',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}
module.exports = app;
