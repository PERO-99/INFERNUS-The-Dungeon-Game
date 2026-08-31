const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'infernus_super_secret_key_change_in_production';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            game_data TEXT
        )`);
    }
});

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

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run('INSERT INTO users (username, password, game_data) VALUES (?, ?, ?)', [username, hashedPassword, '{}'], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Username already exists' });
                }
                return res.status(500).json({ error: 'Database error' });
            }
            
            const token = jwt.sign({ id: this.lastID, username }, SECRET_KEY, { expiresIn: '7d' });
            res.json({ message: 'User registered successfully', token, game_data: {} });
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(400).json({ error: 'Invalid credentials' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user.id, username: user.username }, SECRET_KEY, { expiresIn: '7d' });
        res.json({ message: 'Login successful', token, game_data: JSON.parse(user.game_data || '{}') });
    });
});

app.post('/api/save', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const gameData = JSON.stringify(req.body.game_data);

    db.run('UPDATE users SET game_data = ? WHERE id = ?', [gameData, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Database error while saving' });
        res.json({ message: 'Game saved successfully' });
    });
});

app.get('/api/load', authenticateToken, (req, res) => {
    const userId = req.user.id;

    db.get('SELECT game_data FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error while loading' });
        if (!row) return res.status(404).json({ error: 'User not found' });
        
        res.json({ game_data: JSON.parse(row.game_data || '{}') });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
