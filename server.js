// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // or use native fetch in Node 18+

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors({
    origin: '*',  // Allow all origins for development
    credentials: true
}));

// Request validation middleware
const validateChatRequest = (req, res, next) => {
    const { systemPrompt, messages, userMessage } = req.body;
    
    if (!systemPrompt || typeof systemPrompt !== 'string') {
        return res.status(400).json({ 
            error: 'Invalid request: systemPrompt is required' 
        });
    }
    
    if (!Array.isArray(messages)) {
        return res.status(400).json({ 
            error: 'Invalid request: messages must be an array' 
        });
    }
    
    if (!userMessage || typeof userMessage !== 'string') {
        return res.status(400).json({ 
            error: 'Invalid request: userMessage is required' 
        });
    }
    
    // Validate message structure
    for (const msg of messages) {
        if (!msg.role || !msg.content) {
            return res.status(400).json({ 
                error: 'Invalid message format' 
            });
        }
        if (!['user', 'assistant'].includes(msg.role)) {
            return res.status(400).json({ 
                error: 'Invalid message role' 
            });
        }
    }
    
    next();
};

// Rate limiting (simple in-memory version - use Redis in production)
const rateLimitMap = new Map();
const RATE_LIMIT = 20; // requests per minute
const RATE_WINDOW = 60000; // 1 minute

const rateLimit = (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
    }
    
    const requests = rateLimitMap.get(ip).filter(time => now - time < RATE_WINDOW);
    
    if (requests.length >= RATE_LIMIT) {
        return res.status(429).json({ 
            error: 'Too many requests. Please try again later.' 
        });
    }
    
    requests.push(now);
    rateLimitMap.set(ip, requests);
    next();
};

// Main chat endpoint
app.post('/chat', validateChatRequest, rateLimit, async (req, res) => {
    try {
        const { systemPrompt, messages, userMessage } = req.body;
        
        // SERVER-SIDE AI CONFIGURATION (never exposed to client)
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        const MODEL = 'claude-sonnet-4-20250514';
        const MAX_TOKENS = 1000;
        const API_VERSION = '2023-06-01';
        
        if (!ANTHROPIC_API_KEY) {
            console.error('CRITICAL: ANTHROPIC_API_KEY not set in environment');
            return res.status(500).json({ 
                error: 'Server configuration error' 
            });
        }
        
        // Build complete conversation history
        const conversationMessages = [
            ...messages,
            { role: 'user', content: userMessage }
        ];
        
        // Call Anthropic API with all provider-specific config
        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': API_VERSION
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: systemPrompt,
                messages: conversationMessages
            })
        });
        
        if (!anthropicResponse.ok) {
            const errorBody = await anthropicResponse.text();
            console.error('Anthropic API Error:', {
                status: anthropicResponse.status,
                body: errorBody
            });
            
            // Don't leak API error details to client
            return res.status(500).json({ 
                error: 'AI service temporarily unavailable' 
            });
        }
        
        const data = await anthropicResponse.json();
        
        // Validate response structure
        if (!data.content || !data.content[0] || !data.content[0].text) {
            console.error('Invalid Anthropic response structure:', data);
            return res.status(500).json({ 
                error: 'Invalid response from AI service' 
            });
        }
        
        // Return ONLY normalized response to client
        res.json({ 
            reply: data.content[0].text 
        });
        
        // Optional: Log for analytics (sanitize sensitive data)
        console.log('Chat request processed:', {
            timestamp: new Date().toISOString(),
            messageCount: conversationMessages.length,
            responseLength: data.content[0].text.length
        });
        
    } catch (error) {
        console.error('Server error in /chat:', error);
        
        // Never expose internal error details to client
        res.status(500).json({ 
            error: 'An unexpected error occurred' 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Sporkal AI Backend running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    if (!process.env.ANTHROPIC_API_KEY) {
        console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set!');
    }
});

app.use(express.static(__dirname));
module.exports = app; // For testing