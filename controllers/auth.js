const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

exports.login = async (req, res) => {
    console.log('Login attempt:', req.body);
    const { email, userId, password } = req.body;
    const identifier = email || userId;

    if (!identifier) {
        return res.status(400).json({ message: 'Email or User ID is required' });
    }

    try {
        console.log('--- LOGIN DEBUG START ---');
        console.log('Identifier received:', identifier);
        
        // Comprehensive search: Check Email, Machine ID, or Employee Database ID
        const [users] = await db.execute(`
            SELECT u.*, e.name as emp_name, e.photo as emp_photo, e.machine_id, e.id as employee_db_id 
            FROM users u 
            LEFT JOIN employees e ON u.employee_id = e.id 
            WHERE u.email = ? OR e.machine_id = ? OR e.id = ?
        `, [identifier, identifier, identifier]);
        
        console.log('Database result count:', users.length);
        
        if (users.length === 0) {
            console.log('FAILURE: No user found matching identifier');
            return res.status(401).json({ message: 'Invalid credentials (User not found)' });
        }

        const user = users[0];
        console.log('User found:', { 
            db_id: user.id, 
            email: user.email, 
            emp_id: user.employee_id, 
            machine_id: user.machine_id,
            role: user.role 
        });

        // Password comparison
        console.log('Comparing password for:', user.email || `EMP-${user.employee_db_id}`);
        const isMatch = await bcrypt.compare(password, user.password);
        console.log('Password match result:', isMatch);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials (Password mismatch)' });
        }

        // Strict Role Validation: The role requested in the UI MUST match the DB role
        const dbRole = user.role?.toLowerCase() || '';
        const reqRole = req.body.role?.toLowerCase() || '';
        
        let isValidRole = false;
        if (!reqRole) {
            isValidRole = true; // Auto-detect role from DB if not provided
        } else if (reqRole === 'superadmin' && (dbRole === 'master admin' || dbRole === 'masteradmin' || dbRole === 'superadmin')) {
            isValidRole = true;
        } else if (reqRole === 'admin' && (dbRole === 'admin' || dbRole === 'hr' || dbRole === 'hr admin')) {
            isValidRole = true;
        } else if (reqRole === 'employee' && dbRole === 'employee') {
            isValidRole = true;
        }

        if (!isValidRole) {
            return res.status(403).json({ message: `Access denied. You do not have ${req.body.role} privileges.` });
        }

        // Check Subscription Expiry for non-superadmins and non-admins
        if (dbRole !== 'superadmin' && dbRole !== 'master admin' && dbRole !== 'masteradmin' && dbRole !== 'admin' && user.company_id) {
            const [subs] = await db.execute(
                'SELECT end_date FROM subscriptions WHERE company_id = ? ORDER BY end_date DESC LIMIT 1', 
                [user.company_id]
            );
            if (subs.length > 0) {
                const latestEndDate = new Date(subs[0].end_date);
                const today = new Date();
                latestEndDate.setHours(23, 59, 59, 999); // End of the day
                
                if (today > latestEndDate) {
                    return res.status(403).json({ 
                        message: 'Your company subscription plan has expired. Please contact your administrator to renew.' 
                    });
                }
            }

            // NEW REAL-TIME SUPERADMIN VERIFICATION
            try {
                const [companies] = await db.execute('SELECT email FROM companies WHERE id = ?', [user.company_id]);
                if (companies.length > 0) {
                    const employerEmail = companies[0].email;
                    const superadminApiUrl = process.env.SUPERADMIN_API_URL;
                    
                    if (superadminApiUrl) {
                        const response = await axios.get(`${superadminApiUrl}/master/verify-subscription?email=${employerEmail}`);
                        if (!response.data || response.data.success === false) {
                            return res.status(403).json({
                                message: response.data.message || 'Subscription verification failed via Superadmin.'
                            });
                        }
                    }
                }
            } catch (superadminErr) {
                console.warn('[AUTH] Superadmin Verification Error (Falling back to local cache):', superadminErr.message);
                // Do not block login if Superadmin server is unreachable (e.g. ECONNREFUSED)
                // Just fall through to the local database expiry check (which is already done above).
            }
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, employee_id: user.employee_id, company_id: user.company_id },
            process.env.JWT_SECRET || 'biotrack_secret_key',
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.emp_name || user.name, // Use latest employee name if available
                email: user.email,
                role: user.role,
                photo: user.emp_photo || user.photo, // Use latest employee photo if available
                employee_id: user.employee_id,
                company_id: user.company_id
            }
        });
    } catch (err) {
        res.status(500).json({ message: 'Server error', error: err.message });
    }
};

exports.register = async (req, res) => {
    let { companyName, adminName, email, password, planId, planName, price, duration } = req.body;
    
    // Default plan if none provided
    if (!planName) {
        planName = 'Free Trial';
    }

    if (!companyName || !adminName || !email || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Check if email already exists
        const [existingUsers] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            await connection.rollback();
            return res.status(400).json({ message: 'Email already registered' });
        }

        // 2. Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // 3. Create Company
        const trialExpiry = new Date();
        trialExpiry.setDate(trialExpiry.getDate() + 7); // 7 day trial
        
        const [companyResult] = await connection.execute(
            'INSERT INTO companies (company_name, owner_name, email, plan, status, trial_expiry) VALUES (?, ?, ?, ?, ?, ?)',
            [companyName, adminName, email, planName, 'active', trialExpiry.toISOString().split('T')[0]]
        );
        const companyId = companyResult.insertId;

        // 4. Create Admin User
        const [userResult] = await connection.execute(
            'INSERT INTO users (name, email, password, role, company_id) VALUES (?, ?, ?, ?, ?)',
            [adminName, email, hashedPassword, 'admin', companyId]
        );
        const userId = userResult.insertId;

        // 5. Create Subscription Entry
        await connection.execute(
            'INSERT INTO subscriptions (company_id, plan_name, amount, billing_cycle, start_date, end_date, payment_status) VALUES (?, ?, ?, ?, CURDATE(), ?, "paid")',
            [companyId, planName, 0, 'monthly', trialExpiry.toISOString().split('T')[0]]
        );

        await connection.commit();

        // 6. Generate JWT Token for auto-login
        const token = jwt.sign(
            { id: userId, role: 'admin', company_id: companyId },
            process.env.JWT_SECRET || 'biotrack_secret_key',
            { expiresIn: '24h' }
        );

        res.json({ 
            message: 'Registration successful.', 
            success: true,
            token,
            user: {
                id: userId,
                name: adminName,
                email: email,
                role: 'admin',
                company_id: companyId
            }
        });
    } catch (err) {
        await connection.rollback();
        console.error('Registration Error:', err);
        res.status(500).json({ message: 'Server error during registration', error: err.message });
    } finally {
        connection.release();
    }
};

