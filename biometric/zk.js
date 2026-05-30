const ZKLib = require('node-zklib');

let zkInstance = null;
let isConnected = false;

const initMachine = async (ip, port, timeout = 10000, inport = 5200) => {
    try {
        zkInstance = new ZKLib(ip, port, timeout, inport);
        await zkInstance.createSocket();
        isConnected = true;
        return zkInstance;
    } catch (error) {
        isConnected = false;
        zkInstance = null;
        throw error;
    }
};

const getMachineInfo = async () => {
    if (!zkInstance || !isConnected) throw new Error('Machine not connected');
    const info = await zkInstance.getInfo();
    return info;
};

const getAttendances = async () => {
    if (!zkInstance || !isConnected) throw new Error('Machine not connected');
    const logs = await zkInstance.getAttendances();
    return logs;
};

const disconnectMachine = async () => {
    if (zkInstance) {
        await zkInstance.disconnect();
        isConnected = false;
        zkInstance = null;
    }
};

const getStatus = () => isConnected;

const purgeMachineData = async () => {
    if (!zkInstance || !isConnected) throw new Error('Machine not connected');
    // 14 is CMD_CLEAR_DATA (clears users, faces, fingerprints)
    await zkInstance.executeCmd(14, ''); 
    // Clear attendance logs as well
    if (typeof zkInstance.clearAttendanceLog === 'function') {
        await zkInstance.clearAttendanceLog();
    } else {
        await zkInstance.executeCmd(15, ''); // 15 is CMD_CLEAR_ATTLOG
    }
    return { success: true };
};

module.exports = {
    initMachine,
    getMachineInfo,
    getAttendances,
    disconnectMachine,
    getStatus,
    purgeMachineData
};
