const db = require('../config/db');

exports.getDashboardStats = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const companyFilter = isMaster ? '' : `WHERE created_by = ${db.escape(req.user.id)}`;
        
        const [companies] = await db.execute(`SELECT COUNT(*) as total FROM companies ${companyFilter}`);
        const [activeCompanies] = await db.execute(`SELECT COUNT(*) as active FROM companies WHERE status = "active" ${isMaster ? '' : `AND created_by = ${db.escape(req.user.id)}`}`);
        const [revenue] = await db.execute(`SELECT SUM(s.amount) as total FROM subscriptions s LEFT JOIN companies c ON s.company_id = c.id WHERE s.payment_status = "paid" ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [admins] = await db.execute(`SELECT COUNT(*) as total FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.role IN ("admin", "Master Admin") ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [employees] = await db.execute(`SELECT COUNT(*) as total FROM employees e LEFT JOIN companies c ON e.company_id = c.id WHERE e.status = "active" ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [attendance] = await db.execute(`SELECT COUNT(*) as present FROM attendance a LEFT JOIN employees e ON a.employee_id = e.id LEFT JOIN companies c ON e.company_id = c.id WHERE a.date = CURDATE() AND a.status IN ("present", "late", "half_day") ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [activePlans] = await db.execute(`SELECT COUNT(*) as active FROM subscriptions s LEFT JOIN companies c ON s.company_id = c.id WHERE s.payment_status = "paid" AND s.end_date >= CURDATE() ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        
        const [recentActivity] = await db.execute(`SELECT a.* FROM audit_logs a LEFT JOIN users u ON a.admin_id = u.id LEFT JOIN companies c ON u.company_id = c.id ${isMaster ? '' : `WHERE c.created_by = ${db.escape(req.user.id)}`} ORDER BY a.created_at DESC LIMIT 5`);

        const chartData = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dStr = d.toISOString().split('T')[0];
            
            const [signupsResult] = await db.execute(`SELECT COUNT(*) as count FROM companies WHERE DATE(created_at) = ? ${isMaster ? '' : `AND created_by = ${db.escape(req.user.id)}`}`, [dStr]);
            const [revenueResult] = await db.execute(`SELECT SUM(s.amount) as total FROM subscriptions s LEFT JOIN companies c ON s.company_id = c.id WHERE DATE(s.created_at) = ? AND s.payment_status="paid" ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`, [dStr]);

            chartData.push({
                name: d.toLocaleDateString('en-US', { weekday: 'short' }),
                signups: signupsResult[0].count || 0,
                revenue: revenueResult[0].total || 0
            });
        }

        res.json({
            totalCompanies: companies[0].total || 0,
            activeCompanies: activeCompanies[0].active || 0,
            monthlyRevenue: revenue[0].total || 0,
            totalAdmins: admins[0].total || 0,
            totalEmployees: employees[0].total || 0,
            presentToday: attendance[0].present || 0,
            activePlans: activePlans[0].active || 0,
            recentActivity: recentActivity,
            chartData: chartData
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getCompanies = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const [rows] = await db.execute(`
            SELECT c.*, 
                   s.plan_name as active_plan, 
                   s.amount as plan_amount, 
                   s.end_date as plan_expiry,
                   s.payment_status as plan_status,
                   (SELECT COUNT(*) FROM employees WHERE company_id = c.id) as employee_count,
                   (SELECT COUNT(*) FROM users WHERE company_id = c.id AND role IN ('admin', 'Master Admin')) as admin_count
            FROM companies c
            LEFT JOIN subscriptions s ON c.id = s.company_id AND s.end_date >= CURDATE() AND s.payment_status = 'paid'
            ${isMaster ? '' : `WHERE c.created_by = ${db.escape(req.user.id)}`}
            ORDER BY c.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.createCompany = async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { company_name, owner_name, email, phone, plan, employee_limit, status, password } = req.body;
        
        // 1. Insert Company
        const [companyResult] = await connection.execute(
            'INSERT INTO companies (company_name, owner_name, email, phone, plan, employee_limit, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [company_name, owner_name, email, phone, plan, employee_limit, status || 'active', req.user.id]
        );
        const companyId = companyResult.insertId;

        // 2. Create Admin User for this company if password is provided
        if (password) {
            const bcrypt = require('bcryptjs');
            const hashedPassword = await bcrypt.hash(password, 10);
            await connection.execute(
                'INSERT INTO users (name, email, password, role, company_id) VALUES (?, ?, ?, ?, ?)',
                [owner_name, email, hashedPassword, 'admin', companyId]
            );
        }

        await connection.commit();
        res.json({ message: 'Company created', id: companyId });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
};

exports.updateCompany = async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        const { company_name, owner_name, email, phone, plan, employee_limit, status, password } = req.body;
        
        // 1. Update Company
        await connection.execute(
            'UPDATE companies SET company_name=?, owner_name=?, email=?, phone=?, plan=?, employee_limit=?, status=? WHERE id=?',
            [company_name, owner_name, email, phone, plan, employee_limit, status, id]
        );

        // 2. Check if Admin User exists for this company
        const [existingAdmins] = await connection.execute(
            'SELECT * FROM users WHERE company_id = ? AND role = "admin"',
            [id]
        );

        const bcrypt = require('bcryptjs');
        if (existingAdmins.length > 0) {
            // Update existing Admin
            if (password) {
                const hashedPassword = await bcrypt.hash(password, 10);
                await connection.execute(
                    'UPDATE users SET name = ?, email = ?, password = ? WHERE company_id = ? AND role = "admin"',
                    [owner_name, email, hashedPassword, id]
                );
            } else {
                await connection.execute(
                    'UPDATE users SET name = ?, email = ? WHERE company_id = ? AND role = "admin"',
                    [owner_name, email, id]
                );
            }
        } else {
            // Create Admin if not exists
            if (password) {
                const hashedPassword = await bcrypt.hash(password, 10);
                await connection.execute(
                    'INSERT INTO users (name, email, password, role, company_id) VALUES (?, ?, ?, ?, ?)',
                    [owner_name, email, hashedPassword, 'admin', id]
                );
            }
        }

        await connection.commit();
        res.json({ message: 'Company updated' });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
};

exports.deleteCompany = async (req, res) => {
    try {
        await db.execute('DELETE FROM companies WHERE id=?', [req.params.id]);
        res.json({ message: 'Company deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.updateCompanyStatus = async (req, res) => {
    try {
        const { status } = req.body;
        await db.execute('UPDATE companies SET status=? WHERE id=?', [status, req.params.id]);
        res.json({ message: 'Status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getRequests = async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM company_requests ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.acceptRequest = async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;
        
        const [requests] = await connection.execute('SELECT * FROM company_requests WHERE id=?', [id]);
        if (requests.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Request not found' });
        }
        const reqData = requests[0];
        if (reqData.status === 'accepted') {
            await connection.rollback();
            return res.status(400).json({ error: 'Request already accepted' });
        }

        // 1. Mark request as accepted
        await connection.execute('UPDATE company_requests SET status="accepted" WHERE id=?', [id]);

        // 2. Insert into companies
        const planToAssign = reqData.plan || 'Free Trial';
        const [companyResult] = await connection.execute(
            'INSERT INTO companies (company_name, owner_name, email, phone, plan, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [reqData.company_name, reqData.owner_name, reqData.email, reqData.phone || '', planToAssign, 'active', req.user.id]
        );
        const companyId = companyResult.insertId;

        // 3. Create Admin User
        await connection.execute(
            'INSERT INTO users (name, email, password, role, company_id) VALUES (?, ?, ?, ?, ?)',
            [reqData.owner_name, reqData.email, reqData.password, 'admin', companyId]
        );

        // 4. Create Subscriptions
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 7); // Default 7 days trial logic, superadmin can adjust later
        await connection.execute(
            'INSERT INTO subscriptions (company_id, plan_name, amount, billing_cycle, start_date, end_date, payment_status) VALUES (?, ?, ?, ?, CURDATE(), ?, "paid")',
            [companyId, planToAssign, 0, 'monthly', endDate.toISOString().split('T')[0]]
        );

        await connection.commit();
        res.json({ message: 'Request accepted, company and admin user created successfully' });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
};

exports.rejectRequest = async (req, res) => {
    try {
        await db.execute('UPDATE company_requests SET status="rejected" WHERE id=?', [req.params.id]);
        res.json({ message: 'Request rejected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getInvoices = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const [rows] = await db.execute(`
            SELECT s.*, c.company_name 
            FROM subscriptions s 
            LEFT JOIN companies c ON s.company_id = c.id 
            ${isMaster ? '' : `WHERE c.created_by = ${db.escape(req.user.id)}`}
            ORDER BY s.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getPayments = async (req, res) => {
    res.json([]);
};

exports.getAnalytics = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const companyFilter = isMaster ? '' : `WHERE created_by = ${db.escape(req.user.id)}`;
        
        // 1. Overview Stats
        const [totalRev] = await db.execute(`SELECT SUM(s.amount) as total FROM subscriptions s LEFT JOIN companies c ON s.company_id = c.id WHERE s.payment_status = "paid" ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [activeSubs] = await db.execute(`SELECT COUNT(*) as active FROM subscriptions s LEFT JOIN companies c ON s.company_id = c.id WHERE s.payment_status = "paid" AND s.end_date >= CURDATE() ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}`);
        const [totalComps] = await db.execute(`SELECT COUNT(*) as total FROM companies ${companyFilter}`);

        // 2. Revenue Trend (Last 6 Months)
        const revenueTrend = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const monthStr = d.toLocaleString('default', { month: 'short' });
            const yearStr = d.getFullYear();
            
            const [revResult] = await db.execute(`
                SELECT SUM(s.amount) as total 
                FROM subscriptions s 
                LEFT JOIN companies c ON s.company_id = c.id 
                WHERE s.payment_status = 'paid' 
                AND MONTH(s.created_at) = ? AND YEAR(s.created_at) = ?
                ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}
            `, [d.getMonth() + 1, yearStr]);
            
            revenueTrend.push({
                name: `${monthStr} ${yearStr}`,
                revenue: revResult[0].total || 0
            });
        }

        // 3. Plan Popularity
        const [planDist] = await db.execute(`
            SELECT s.plan_name as name, COUNT(*) as value 
            FROM subscriptions s 
            LEFT JOIN companies c ON s.company_id = c.id 
            WHERE s.payment_status = 'paid' AND s.end_date >= CURDATE()
            ${isMaster ? '' : `AND c.created_by = ${db.escape(req.user.id)}`}
            GROUP BY s.plan_name
        `);

        // If no plans, provide dummy for empty state
        const finalPlanDist = planDist.length > 0 ? planDist : [{ name: 'No Active Plans', value: 1 }];

        res.json({ 
            overview: {
                totalRevenue: totalRev[0].total || 0,
                activeSubscriptions: activeSubs[0].active || 0,
                totalCompanies: totalComps[0].total || 0
            },
            revenueTrend,
            planDistribution: finalPlanDist
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getSettings = async (req, res) => {
    res.json({ platform: 'Kiaan HRM Pro SuperAdmin' });
};

exports.updateSettings = async (req, res) => {
    res.json({ message: 'Updated' });
};

exports.getPlanRequests = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const [rows] = await db.execute(`
            SELECT pr.*, c.company_name, c.email 
            FROM plan_requests pr
            LEFT JOIN companies c ON pr.company_id = c.id
            ${isMaster ? '' : `WHERE c.created_by = ${db.escape(req.user.id)}`}
            ORDER BY pr.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.handlePlanRequest = async (req, res) => {
    try {
        const { id, action } = req.params;
        if (action !== 'accept' && action !== 'reject') return res.status(400).json({ error: 'Invalid action' });
        
        const status = action === 'accept' ? 'approved' : 'rejected';
        await db.execute('UPDATE plan_requests SET status = ? WHERE id = ?', [status, id]);
        
        if (action === 'accept') {
            const [reqs] = await db.execute('SELECT company_id, requested_plan FROM plan_requests WHERE id = ?', [id]);
            if (reqs.length > 0) {
                const { company_id, requested_plan } = reqs[0];
                await db.execute('UPDATE companies SET plan = ? WHERE id = ?', [requested_plan, company_id]);
                
                const amount = requested_plan === 'Pro' ? 299 : requested_plan === 'Enterprise' ? 999 : 0;
                const endDate = new Date();
                endDate.setFullYear(endDate.getFullYear() + 1);
                
                // Add new subscription
                await db.execute(
                    'INSERT INTO subscriptions (company_id, plan_name, amount, billing_cycle, start_date, end_date, payment_status) VALUES (?, ?, ?, ?, CURDATE(), ?, "paid")',
                    [company_id, requested_plan, amount, 'annually', endDate.toISOString().split('T')[0]]
                );
            }
        }
        res.json({ message: `Plan request ${status}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getPlans = async (req, res) => {
    try {
        const isMaster = req.user.role && req.user.role.toLowerCase().includes('master');
        const [rows] = await db.execute(`SELECT * FROM plans ${isMaster ? '' : `WHERE created_by = ${db.escape(req.user.id)}`} ORDER BY id ASC`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.createPlan = async (req, res) => {
    try {
        const { name, price, duration, description, features, buttonText, isPopular } = req.body;
        await db.execute(
            'INSERT INTO plans (name, price, duration, description, features, buttonText, isPopular, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, price, duration, description, JSON.stringify(features), buttonText, isPopular ? 1 : 0, req.user.id]
        );
        res.json({ message: 'Plan created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.updatePlan = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, duration, description, features, buttonText, isPopular } = req.body;
        await db.execute(
            'UPDATE plans SET name=?, price=?, duration=?, description=?, features=?, buttonText=?, isPopular=? WHERE id=?',
            [name, price, duration, description, JSON.stringify(features), buttonText, isPopular ? 1 : 0, id]
        );
        res.json({ message: 'Plan updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.deletePlan = async (req, res) => {
    try {
        await db.execute('DELETE FROM plans WHERE id=?', [req.params.id]);
        res.json({ message: 'Plan deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
