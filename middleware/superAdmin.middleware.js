const jwt = require('jsonwebtoken');

exports.superAdminOnly = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'No token provided' });
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'biotrack_secret_key_2026_pro');
        if (!decoded.role || decoded.role.toLowerCase() !== 'superadmin') {
            return res.status(403).json({ message: 'SuperAdmin access required' });
        }
        
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};
