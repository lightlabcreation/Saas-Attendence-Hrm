const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../config/db');

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_T1r8sgDPyFz1bB',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'GBL1GdG1iHJWvDEFkvDyG0Bf',
});

exports.createRazorpayOrder = async (req, res) => {
  try {
    const { plan_id } = req.body;
    const companyId = req.user.company_id;

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'User is not assigned to any company.' });
    }

    const [compRows] = await db.execute('SELECT * FROM companies WHERE id = ? LIMIT 1', [companyId]);
    const company = compRows[0];
    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }

    const [planRows] = await db.execute('SELECT * FROM plans WHERE id = ? LIMIT 1', [plan_id]);
    const plan = planRows[0];
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found.' });
    }

    // Convert USD price to INR in paise
    const usdAmount = parseFloat(plan.price.replace(/[^0-9.]/g, ''));
    const inrAmount = Math.round(usdAmount * 80);
    const amountInPaise = inrAmount * 100;

    if (amountInPaise <= 0) {
      return res.status(400).json({ success: false, message: 'Cannot purchase a free plan through Razorpay payment.' });
    }

    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}_${company.id}`,
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_T1r8sgDPyFz1bB',
      order,
      plan: {
        id: plan.id,
        name: plan.name,
        price: plan.price
      }
    });

  } catch (error) {
    console.error('Razorpay Create Order Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.verifyPayment = async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = req.body;
    const userId = req.user.id;
    const companyId = req.user.company_id;

    // Verify signature
    const secret = process.env.RAZORPAY_KEY_SECRET || 'GBL1GdG1iHJWvDEFkvDyG0Bf';
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Payment verification failed: invalid signature.' });
    }

    // 1. Get Company
    const [compRows] = await connection.execute('SELECT * FROM companies WHERE id = ? LIMIT 1', [companyId]);
    const company = compRows[0];
    if (!company) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Company not found.' });
    }

    // 2. Get Plan
    const [planRows] = await connection.execute('SELECT * FROM plans WHERE id = ? LIMIT 1', [plan_id]);
    const plan = planRows[0];
    if (!plan) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ success: false, message: 'Plan not found.' });
    }

    const usdAmount = parseFloat(plan.price.replace(/[^0-9.]/g, ''));
    const amount = usdAmount;

    // 3. Manage Subscription
    // Delete/expire any existing subscriptions
    await connection.execute(
      "UPDATE subscriptions SET payment_status = 'failed', updated_at = NOW() WHERE company_id = ? AND payment_status = 'pending'",
      [company.id]
    );

    // Create new active Subscription
    const startDate = new Date();
    const endDate = new Date(startDate);
    
    // Determine months from plan duration
    let months = 1;
    if (plan.duration.toLowerCase().includes('2 month')) {
      months = 2;
    } else if (plan.duration.toLowerCase().includes('3 month')) {
      months = 3;
    } else if (plan.duration.toLowerCase().includes('7 day')) {
      months = 0.23; // roughly 7 days
    }
    
    if (months === 0.23) {
      endDate.setDate(endDate.getDate() + 7);
    } else {
      endDate.setMonth(endDate.getMonth() + months);
    }

    const [subDetails] = await connection.execute(
      `INSERT INTO subscriptions (company_id, plan_name, amount, billing_cycle, payment_status, start_date, end_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paid', CURDATE(), ?, NOW(), NOW())`,
      [company.id, plan.name, amount, months === 0.23 ? 'weekly' : 'monthly', endDate.toISOString().split('T')[0]]
    );

    // Update company current plan name
    await connection.execute('UPDATE companies SET plan = ?, status = \'active\' WHERE id = ?', [plan.name, company.id]);

    // 4. Sync to Master Database
    try {
      // Find the admin user email for this company
      const [adminRows] = await connection.execute(
        'SELECT email FROM users WHERE company_id = ? AND role = "admin" LIMIT 1',
        [company.id]
      );
      if (adminRows.length > 0) {
        const adminEmail = adminRows[0].email;
        const durationDays = months === 0.23 ? 7 : Math.round(months * 30);
        const masterApiUrl = process.env.SUPERADMIN_API_URL || 'http://localhost:5000/api';
        
        await axios.post(`${masterApiUrl}/master/upgrade-subscription`, {
          email: adminEmail,
          plan: plan.name,
          planPrice: amount,
          durationDays: durationDays
        }, {
          headers: {
            'x-internal-api-key': process.env.INTERNAL_API_KEY || 'kiaan_attendance_secret_2026'
          }
        });
        console.log(`[PAYMENT_SYNC] Synced subscription upgrade to Master for admin: ${adminEmail}`);
      }
    } catch (syncErr) {
      console.error('[PAYMENT_SYNC] Failed to sync subscription upgrade to Master database:', syncErr.message);
    }

    // 5. Audit Log (Optional)
    try {
      await connection.execute(
        'INSERT INTO audit_logs (admin_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, NOW())',
        [userId, 'PLAN_PURCHASED', company.id, JSON.stringify({ plan_name: plan.name, payment_id: razorpay_payment_id, order_id: razorpay_order_id })]
      );
    } catch (e) {
      console.warn('[AUDIT] Skipping audit log insertion (non-fatal):', e.message);
    }

    await connection.commit();
    connection.release();

    res.json({
      success: true,
      message: 'Plan purchased and activated successfully.',
    });

  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollErr) {}
    connection.release();
    console.error('Razorpay Verify Payment Controller Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
