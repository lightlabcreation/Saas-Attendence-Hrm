const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({ message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'biotrack_secret_key_2026_pro');
        req.user = decoded; // Contains id, role, employee_id, company_id
        
        // Check 10-Day free trial / subscription expiry for non-superadmins
        if (decoded.role !== 'superadmin' && decoded.company_id) {
            try {
                const [companyRows] = await db.execute('SELECT created_at, plan FROM companies WHERE id = ? LIMIT 1', [decoded.company_id]);
                if (companyRows.length > 0) {
                    const company = companyRows[0];
                    
                    // Calculate difference in days since creation
                    const createdDate = new Date(company.created_at);
                    const now = new Date();
                    const diffTime = Math.abs(now - createdDate);
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    
                    if (diffDays > 10) {
                        // Trial period is over (10 days). Check if there is an active subscription
                        const [subRows] = await db.execute(
                            "SELECT * FROM subscriptions WHERE company_id = ? AND payment_status = 'paid' AND end_date >= CURDATE() LIMIT 1",
                            [decoded.company_id]
                        );
                        
                        const hasActiveSub = subRows.length > 0;
                        
                        if (!hasActiveSub) {
                            const path = req.originalUrl || req.path || '';
                            const isBillingOrSupportRoute = path.includes('/settings/plan-request') || 
                                                           path.includes('/plans') || 
                                                           path.includes('/settings/current-plan') || 
                                                           path.includes('/razorpay') ||
                                                           path.includes('/auth') ||
                                                           path.includes('/support');
                            
                            if (!isBillingOrSupportRoute) {
                                return res.status(403).json({
                                    success: false,
                                    code: 'TRIAL_EXPIRED',
                                    message: 'Your 10-Day Free Trial has expired. Please purchase a plan to continue.'
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('[AUTH_MIDDLEWARE] Subscription expiry check failed:', err.message);
            }
        }
        
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};
