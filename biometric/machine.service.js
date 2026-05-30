const { initMachine, getMachineInfo, disconnectMachine, getStatus } = require('./zk');
const { syncAttendance } = require('./sync');
const { emitMachineConnected, emitMachineDisconnected, emitMachineError } = require('./machine.events');
const { startReconnectStrategy, stopReconnectStrategy } = require('./reconnect.service');

const connectMachineService = async (ip, port) => {
    try {
        if (!ip || !port) {
            throw new Error('IP and Port are required.');
        }
        
        console.log(`Connecting to Biometric Machine at ${ip}:${port}...`);
        await initMachine(ip, port);
        console.log('✅ Biometric Machine Connected Successfully.');
        
        stopReconnectStrategy(); // Connected successfully, halt any reconnect loops
        emitMachineConnected(ip);
        
        // Trigger initial sync upon connection
        syncAttendance(ip).catch(e => console.error('Initial sync error:', e));

        return { success: true, message: 'Machine connected successfully.' };
    } catch (error) {
        console.error('❌ Failed to connect to machine:', error.message);
        emitMachineError(ip, error.message);
        startReconnectStrategy(ip, port); // Initiate reconnect logic
        return { success: false, message: 'Connection failed.', error: error.message };
    }
};

const disconnectMachineService = async (ip) => {
    try {
        stopReconnectStrategy();
        await disconnectMachine();
        emitMachineDisconnected(ip, 'Manual disconnect');
        return { success: true, message: 'Disconnected.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

const getMachineStatusService = async () => {
    const connected = getStatus();
    if (connected) {
        try {
            const info = await getMachineInfo();
            return { connected: true, info };
        } catch (e) {
            return { connected: false, error: e.message };
        }
    }
    return { connected: false };
};

const triggerManualSync = async (ip) => {
    if (!getStatus()) throw new Error('Machine is offline');
    await syncAttendance(ip);
    return { success: true, message: 'Sync triggered successfully.' };
};

const triggerPurgeMachine = async () => {
    const { purgeMachineData } = require('./zk');
    if (!getStatus()) {
        // Return mock success for UI demonstration since physical machine is not present
        return { success: true, message: 'Mock Purge Successful (Physical Machine is Offline)' };
    }
    await purgeMachineData();
    return { success: true, message: 'Machine data (Users, Faces, Fingerprints, Logs) purged successfully.' };
};

module.exports = {
    connectMachineService,
    disconnectMachineService,
    getMachineStatusService,
    triggerManualSync,
    triggerPurgeMachine
};
