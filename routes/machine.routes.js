const express = require('express');
const router = express.Router();
const { connectMachineService, disconnectMachineService, getMachineStatusService, triggerManualSync, triggerPurgeMachine } = require('../biometric/machine.service');

// API to check machine status
router.get('/status', async (req, res) => {
    try {
        const status = await getMachineStatusService();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API to manually connect (or re-connect) the machine
router.post('/connect', async (req, res) => {
    const { ip, port } = req.body;
    const ipToUse = ip || process.env.MACHINE_IP;
    const portToUse = port || process.env.MACHINE_PORT || 4370;

    if (!ipToUse) {
        return res.status(400).json({ success: false, message: 'Machine IP is required' });
    }

    const result = await connectMachineService(ipToUse, portToUse);
    res.json(result);
});

// API to trigger a manual sync of attendance
router.post('/sync', async (req, res) => {
    try {
        const ipToUse = req.body.ip || process.env.MACHINE_IP;
        const result = await triggerManualSync(ipToUse);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API to disconnect the machine
router.post('/disconnect', async (req, res) => {
    const ipToUse = req.body.ip || process.env.MACHINE_IP;
    const result = await disconnectMachineService(ipToUse);
    res.json(result);
});

// API to test machine connection without saving state
router.post('/test', async (req, res) => {
    const { ip, port } = req.body;
    if (!ip) return res.status(400).json({ success: false, message: 'IP required for testing' });
    
    try {
        const testResult = await connectMachineService(ip, port || 4370);
        if (testResult.success) {
            await disconnectMachineService(ip); // Disconnect immediately after successful test
        }
        res.json(testResult);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to purge machine data
router.post('/purge', async (req, res) => {
    try {
        const result = await triggerPurgeMachine();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to fetch live attendance today (can be used for polling if socket is unavailable)
router.get('/live', async (req, res) => {
    try {
        const db = require('../../config/db');
        const moment = require('moment-timezone');
        const today = moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
        
        const [records] = await db.execute(
            `SELECT a.*, e.name, e.employee_id as emp_id 
             FROM attendance a 
             JOIN employees e ON a.employee_id = e.id 
             WHERE a.date = ? ORDER BY a.in_time DESC LIMIT 10`,
            [today]
        );
        res.json({ success: true, data: records });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
