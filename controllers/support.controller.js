const db = require('../config/db');
const axios = require('axios');

/**
 * Helper to fetch company details for a user
 */
const getUserCompanyDetails = async (userId) => {
  try {
    const [rows] = await db.execute(`
      SELECT c.id as company_id, c.company_name 
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      WHERE u.id = ? LIMIT 1
    `, [userId]);
    if (rows.length > 0) return rows[0];
  } catch (err) {
    console.error('[SUPPORT_CONTROLLER] Error fetching company details:', err);
  }
  return { company_id: 0, company_name: 'Unknown Company' };
};

/**
 * Raise a Support Ticket
 */
exports.createTicket = async (req, res) => {
  const connection = await db.getConnection();
  await connection.beginTransaction();
  try {
    const { subject, category, priority, description } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;
    
    const userDetails = await getUserCompanyDetails(userId);
    const companyId = userDetails.company_id;
    const companyName = userDetails.company_name;

    if (!subject || !description) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ success: false, message: 'Subject and Description are required.' });
    }

    const ticketNumber = 'TKT-' + Date.now().toString().slice(-8) + '-' + Math.floor(100 + Math.random() * 900);

    // 1. Save ticket in Attendance DB
    const [ticketResult] = await connection.execute(
      `INSERT INTO support_tickets (ticket_number, company_id, company_name, project_name, user_id, subject, category, priority, description, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Attendance SaaS', ?, ?, ?, ?, ?, 'Open', NOW(), NOW())`,
      [ticketNumber, companyId, companyName, userId, subject, category, priority || 'Low', description]
    );
    const ticketId = ticketResult.insertId;

    // 2. Save first message in ticket_messages
    await connection.execute(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message, created_at)
       VALUES (?, 'client', ?, ?, NOW())`,
      [ticketId, userId, description]
    );

    await connection.commit();
    connection.release();

    // 3. Sync to Super Admin Backend (if raised by admin/hr/employer)
    let superadminSynced = false;
    const isPlatformTicket = userRole === 'admin' || userRole === 'hr' || userRole === 'Master Admin' || userRole === 'superadmin';
    
    if (isPlatformTicket) {
      try {
        const saUrl = `${process.env.SUPERADMIN_API_URL || 'http://localhost:5000/api'}/support/create-ticket`;
        const saBody = {
          ticketNumber,
          companyId,
          companyName,
          userId,
          subject,
          category,
          priority,
          description,
          projectName: 'Attendance SaaS'
        };
        const response = await axios.post(saUrl, saBody, {
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-key': process.env.INTERNAL_API_KEY || 'kiaan_attendance_secret_2026'
          },
          timeout: 5000
        });
        if (response.data.success) {
          superadminSynced = true;
        }
      } catch (err) {
        console.error('[SUPPORT] Failed to sync ticket to Super Admin (non-fatal):', err.message);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Ticket created successfully.',
      ticket: {
        id: ticketId,
        ticketNumber,
        subject,
        status: 'Open',
        superadminSynced
      }
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollErr) {}
    connection.release();
    console.error('Create Ticket Error:', error);
    res.status(500).json({ success: false, message: 'Server error during ticket creation', error: error.message });
  }
};

/**
 * Get tickets raised by the current user
 */
exports.getMyTickets = async (req, res) => {
  try {
    const userId = req.user.id;
    const [tickets] = await db.execute(
      `SELECT * FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ success: true, tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get tickets raised by Employees in the Company
 */
exports.getCompanyTickets = async (req, res) => {
  try {
    const userId = req.user.id;
    const userDetails = await getUserCompanyDetails(userId);
    
    // Fetch tickets of this company raised by employees
    const [tickets] = await db.execute(
      `SELECT t.*, u.name as sender_name, u.role as sender_role 
       FROM support_tickets t
       JOIN users u ON t.user_id = u.id
       WHERE t.company_id = ? AND u.role = 'employee'
       ORDER BY t.created_at DESC`,
      [userDetails.company_id]
    );
    res.json({ success: true, tickets });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get Ticket Details and Chat Timeline
 */
exports.getTicketDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const [tickets] = await db.execute('SELECT * FROM support_tickets WHERE id = ?', [id]);
    const ticket = tickets[0];

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    // Fetch messages
    const [messages] = await db.execute(
      `SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC`,
      [id]
    );

    res.json({ success: true, ticket, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Send reply message
 */
exports.replyToTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!message) {
      return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    }

    const [tickets] = await db.execute('SELECT * FROM support_tickets WHERE id = ?', [id]);
    const ticket = tickets[0];
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    // Determine sender type (Admin is 'admin' only when replying to an employee's ticket)
    let senderType = 'client';
    if (userRole === 'admin' || userRole === 'hr' || userRole === 'Master Admin') {
      if (ticket.user_id !== userId) {
        senderType = 'admin';
      }
    }

    // Insert message
    await db.execute(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [id, senderType, userId, message]
    );

    // Update status to In Progress if Admin replied to an Employee ticket
    let newStatus = ticket.status;
    if (senderType === 'admin' && ticket.status === 'Open') {
      newStatus = 'In Progress';
    }
    await db.execute(
      `UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?`,
      [newStatus, id]
    );

    // If this is a ticket raised to Super Admin, sync the reply to Super Admin backend
    const isPlatformTicket = userRole === 'admin' || userRole === 'hr' || userRole === 'Master Admin' || userRole === 'superadmin';
    if (ticket.user_id === userId && isPlatformTicket) {
      try {
        const saUrl = `${process.env.SUPERADMIN_API_URL || 'http://localhost:5000/api'}/support/reply/${ticket.ticket_number}`;
        await axios.post(saUrl, {
          message,
          senderType: 'client',
          senderId: userId
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-key': process.env.INTERNAL_API_KEY || 'kiaan_attendance_secret_2026'
          },
          timeout: 5000
        });
      } catch (err) {
        console.error('[SUPPORT] Failed to sync reply to Super Admin (non-fatal):', err.message);
      }
    }

    res.json({ success: true, message: 'Reply sent successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Update Ticket Status (Resolve / Close)
 */
exports.updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'Resolved', 'Closed', etc.

    if (!['Resolved', 'Closed', 'In Progress', 'Open'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    const [result] = await db.execute(
      'UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    // Sync status back to Super Admin
    const [tickets] = await db.execute('SELECT * FROM support_tickets WHERE id = ?', [id]);
    const ticket = tickets[0];
    if (ticket) {
      try {
        const saUrl = `${process.env.SUPERADMIN_API_URL || 'http://localhost:5000/api'}/support/${ticket.ticket_number}/status`;
        await axios.put(saUrl, { status }, {
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-key': process.env.INTERNAL_API_KEY || 'kiaan_attendance_secret_2026'
          },
          timeout: 5000
        });
      } catch (err) {
        console.error('[SUPPORT] Failed to sync status to Super Admin (non-fatal):', err.message);
      }
    }

    res.json({ success: true, message: 'Ticket status updated.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Sync status & replies from Super Admin to Attendance DB
 */
exports.syncTicketFromSuperadmin = async (req, res) => {
  try {
    const { action, ticketNumber, reply, status } = req.body;

    const [tickets] = await db.execute('SELECT * FROM support_tickets WHERE ticket_number = ?', [ticketNumber]);
    const ticket = tickets[0];

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }

    if (action === 'reply' && reply) {
      await db.execute(
        `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message, created_at)
         VALUES (?, 'admin', ?, ?, NOW())`,
        [ticket.id, 0, reply]
      );
      
      await db.execute(
        `UPDATE support_tickets SET status = 'Waiting For Client', updated_at = NOW() WHERE id = ?`,
        [ticket.id]
      );
    } else if (action === 'status' && status) {
      await db.execute(
        `UPDATE support_tickets SET status = ?, updated_at = NOW() WHERE id = ?`,
        [status, ticket.id]
      );
    }

    res.json({ success: true, message: 'Sync successful.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Create Support Ticket from Public Login Page (Help Modal)
 */
exports.createPublicTicket = async (req, res) => {
  try {
    const { email, name, phone, subject, description, category = 'General Support' } = req.body;

    if (!email || !subject || !description) {
      return res.status(400).json({ success: false, message: 'Email, Subject, and Description are required.' });
    }

    // Check if user exists in hrmattendencesaas_local to link the ticket
    const [userRows] = await db.execute('SELECT id, role, company_id FROM users WHERE email = ? LIMIT 1', [email.toLowerCase()]);
    
    let userId = 0;
    let userRole = 'public';
    let companyId = 0;
    let companyName = 'Public Inquiry';

    if (userRows.length > 0) {
      userId = userRows[0].id;
      userRole = userRows[0].role?.toLowerCase() || '';
      companyId = userRows[0].company_id || 0;

      if (companyId) {
        try {
          const [compRows] = await db.execute('SELECT company_name FROM companies WHERE id = ? LIMIT 1', [companyId]);
          if (compRows.length > 0) {
            companyName = compRows[0].company_name;
          }
        } catch (compErr) {
          console.error('[PUBLIC_SUPPORT] Error fetching company details:', compErr);
        }
      }
    }

    const ticketNumber = 'TKT-PUB-' + Date.now().toString().slice(-6) + '-' + Math.floor(100 + Math.random() * 900);
    const fullDescription = `Sender Name: ${name || 'N/A'}\nSender Phone: ${phone || 'N/A'}\nSender Email: ${email}\n\n${description}`;

    // Save ticket locally
    const [ticketResult] = await db.execute(
      `INSERT INTO support_tickets (ticket_number, company_id, company_name, project_name, user_id, subject, category, priority, description, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Attendance SaaS', ?, ?, ?, 'Medium', ?, 'Open', NOW(), NOW())`,
      [ticketNumber, companyId, companyName, userId, `[Public Form] ${subject}`, category, fullDescription]
    );
    const ticketId = ticketResult.insertId;

    // Save message in ticket_messages
    await db.execute(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, message, created_at)
       VALUES (?, 'client', ?, ?, NOW())`,
      [ticketId, userId, `Sender: ${email}\nMessage: ${description}`]
    );

    // Sync to Super Admin Backend
    let superadminSynced = false;
    try {
      const saUrl = `${process.env.SUPERADMIN_API_URL || 'http://localhost:5000/api'}/support/create-ticket`;
      const saBody = {
        ticketNumber,
        companyId,
        companyName,
        userId,
        subject: `[Public Ticket] ${subject}`,
        category,
        priority: 'Medium',
        description: fullDescription,
        projectName: 'Attendance SaaS'
      };
      const response = await axios.post(saUrl, saBody, {
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-key': process.env.INTERNAL_API_KEY || 'kiaan_attendance_secret_2026'
        },
        timeout: 5000
      });
      if (response.data.success) {
        superadminSynced = true;
      }
    } catch (err) {
      console.error('[PUBLIC_SUPPORT] Failed to sync ticket to Super Admin (non-fatal):', err.message);
    }

    res.status(201).json({
      success: true,
      message: 'Support request submitted successfully.',
      ticketNumber
    });
  } catch (error) {
    console.error('Create Public Ticket Error:', error);
    res.status(500).json({ success: false, message: 'Server error during ticket submission', error: error.message });
  }
};
