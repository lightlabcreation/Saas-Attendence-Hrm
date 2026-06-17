const express = require('express');
const router = express.Router();
const supportController = require('../controllers/support.controller');
const auth = require('../middleware/auth');

// All endpoints require authentication
router.use(auth);

// General ticket operations
router.post('/create-ticket', supportController.createTicket);
router.get('/my-tickets', supportController.getMyTickets);
router.get('/ticket/:id', supportController.getTicketDetails);
router.post('/reply/:id', supportController.replyToTicket);
router.put('/ticket/:id/status', supportController.updateTicketStatus);

// Admin-only endpoint to fetch tickets raised by Employees
router.get('/company-tickets', supportController.getCompanyTickets);

module.exports = router;
