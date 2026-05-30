const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Helper: treat 'admin', 'Master Admin', 'hr', and 'hr admin' as admin roles
const isAdmin = (role) => {
    if (!role) return false;
    const r = role.toLowerCase();
    return r === 'admin' || r === 'master admin' || r === 'hr' || r === 'hr admin';
};

// Get the next available IDs for new employee
exports.getNextIds = async (req, res) => {
    try {
        const [[lastEmp]] = await db.execute("SELECT custom_id FROM employees WHERE custom_id REGEXP '^[0-9]+$' ORDER BY CAST(custom_id AS UNSIGNED) DESC LIMIT 1");
        const nextCustomId = lastEmp && lastEmp.custom_id ? (parseInt(lastEmp.custom_id) + 1) : 1001;

        const [[lastMachine]] = await db.execute("SELECT machine_id FROM employees WHERE machine_id REGEXP '^[0-9]+$' ORDER BY CAST(machine_id AS UNSIGNED) DESC LIMIT 1");
        const nextMachineId = lastMachine && lastMachine.machine_id ? (parseInt(lastMachine.machine_id) + 1) : 1001;

        res.json({ nextCustomId, nextMachineId });
    } catch (err) {
        res.status(500).json({ message: 'Error fetching next IDs', error: err.message });
    }
};

// Get all employees (Filtered by creator if admin)
exports.getAllEmployees = async (req, res) => {
    try {
        let query = 'SELECT * FROM employees WHERE 1=1';
        let params = [];

        if (req.user.role !== 'MasterAdmin') {
            query += ' AND company_id = ?';
            params.push(req.user.company_id);
        }

        query += ' ORDER BY created_at DESC';

        console.log('📝 Executing SQL:', query, 'Params:', params);
        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('❌ SQL Error (getAllEmployees):', err);
        res.status(500).json({ message: 'Error fetching employees', error: err.message });
    }
};

// Add new employee / staff / admin
exports.addEmployee = async (req, res) => {
    const {
        machine_id, custom_id, name, role, department, shift, email, phone,
        salary_rate, salary_type, password, joined_date,
        uif_number, advance_balance, signature, is_uif_registered
    } = req.body;

    console.log('📝 Add Employee Request. Signature received:', signature ? (signature.length + ' chars') : 'NO');

    // User who is creating this record
    const creatorId = req.user.id;

    // Use uploaded file if present
    let photo = req.body.photo;
    if (req.file) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        photo = `${protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    try {
        // --- 1. Auto Generate Magic Numbers ---
        const [[lastEmp]] = await db.execute("SELECT custom_id FROM employees WHERE custom_id REGEXP '^[0-9]+$' ORDER BY CAST(custom_id AS UNSIGNED) DESC LIMIT 1");
        const nextCustomId = lastEmp && lastEmp.custom_id ? (parseInt(lastEmp.custom_id) + 1) : 1001;

        const [[lastMachine]] = await db.execute("SELECT machine_id FROM employees WHERE machine_id REGEXP '^[0-9]+$' ORDER BY CAST(machine_id AS UNSIGNED) DESC LIMIT 1");
        const nextMachineId = lastMachine && lastMachine.machine_id ? (parseInt(lastMachine.machine_id) + 1) : 1001;

        // 2. Insert into employees table
        const formattedJoinedDate = joined_date ? joined_date.split('T')[0] : new Date().toISOString().split('T')[0];

        // Ensure role is valid — normalize if it's an admin variant
        const dbRole = isAdmin(role) ? role.toLowerCase() : 'employee';
        const dbShift = ['Morning Shift', 'Evening Shift', 'Night Shift'].includes(shift) ? shift : 'Morning Shift';
        const dbSalaryType = ['hourly', 'daily'].includes(salary_type) ? salary_type : 'hourly';

        const empSql = 'INSERT INTO employees (machine_id, custom_id, name, role, department, shift, email, phone, salary_rate, salary_type, joined_date, photo, uif_number, advance_balance, signature, created_by, is_uif_registered, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        const empValues = [
            nextMachineId.toString(),
            custom_id || nextCustomId.toString(),
            name || '',
            dbRole,
            department || 'General',
            dbShift,
            email || '',
            phone || '',
            parseFloat(salary_rate) || 0,
            dbSalaryType,
            formattedJoinedDate,
            photo || null,
            uif_number || '',
            parseFloat(advance_balance) || 0,
            signature || null,
            creatorId,
            (is_uif_registered === 'true' || is_uif_registered === true || is_uif_registered === 1 || is_uif_registered === '1') ? 1 : 0,
            req.user.company_id
        ];

        console.log('📝 Saving Signature to DB. Length:', signature ? signature.length : 'EMPTY');

        console.log('📝 Executing SQL (Add Employee):', empSql, 'Params:', empValues);
        const [empResult] = await db.execute(empSql, empValues);

        const employeeId = empResult.insertId;
        const hashedPassword = await bcrypt.hash(password || '123456', 10);

        // 3. Create login user
        const finalRole = isAdmin(role) ? role.toLowerCase() : 'employee';
        const userSql = 'INSERT INTO users (employee_id, email, password, role, name, created_by, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const userValues = [employeeId, email || '', hashedPassword, finalRole, name || '', creatorId, req.user.company_id];

        console.log('📝 Executing SQL (Create User):', userSql, 'Params:', userValues);
        await db.execute(userSql, userValues);

        res.status(201).json({ message: 'Personnel added successfully', id: employeeId });
    } catch (err) {
        console.error('❌ SQL Error (addEmployee):', err);
        if (err.code === 'ER_DUP_ENTRY') {
            const field = err.message.includes('machine_id') ? 'Machine ID' : 'Email';
            return res.status(400).json({ message: `Duplicate entry: This ${field} is already assigned to another employee.` });
        }
        res.status(500).json({ message: 'Error adding personnel', error: err.message });
    }
};

// Get single employee details
exports.getEmployeeById = async (req, res) => {
    try {
        const sql = 'SELECT * FROM employees WHERE id = ?';
        console.log('📝 Executing SQL:', sql, 'Params:', [req.params.id]);
        const [rows] = await db.execute(sql, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found' });

        // Safety: If regular admin (not Master Admin), check if they own this record
        if (req.user.role !== 'MasterAdmin' && rows[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Access denied to this record' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('❌ SQL Error (getEmployeeById):', err);
        res.status(500).json({ message: 'Server error', error: err.message });
    }
};

// Update employee
exports.updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    console.log('📝 Incoming Employee Update Request - ID:', id);
    console.log('📝 Data Received:', JSON.stringify(data, null, 2));

    // Handle Profile Image Upload
    let photo = data.photo;
    if (req.file) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        photo = `${protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    try {
        // 1. Safety Check: Verify ownership if admin
        const [existing] = await db.execute('SELECT company_id FROM employees WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ message: 'Employee not found' });

        if (req.user.role !== 'MasterAdmin' && existing[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Cannot edit staff from another company' });
        }

        // 2. Build Dynamic Update for Employees Table
        const empUpdates = [];
        const empParams = [];

        const empFields = [
            'machine_id', 'custom_id', 'name', 'role', 'department', 'shift',
            'email', 'phone', 'salary_rate', 'salary_type', 'uif_number',
            'advance_balance', 'status'
        ];

        empFields.forEach(field => {
            if (data[field] !== undefined) {
                empUpdates.push(`\`${field}\` = ?`);
                let val = data[field] === '' ? null : data[field];

                // Ensure numeric fields are numbers or null
                if (field === 'salary_rate' || field === 'advance_balance') {
                    const parsed = parseFloat(val);
                    val = isNaN(parsed) ? 0 : parsed;
                }

                // Map/Validate ENUM fields
                if (field === 'role') val = isAdmin(val) ? val.toLowerCase() : 'employee';
                if (field === 'shift') {
                    const validShifts = ['Morning Shift', 'Evening Shift', 'Night Shift'];
                    if (!validShifts.includes(val)) val = 'Morning Shift';
                }
                if (field === 'status') {
                    const validStatus = ['active', 'on_leave', 'terminated'];
                    if (!validStatus.includes(val)) val = 'active';
                }
                if (field === 'salary_type') {
                    const validTypes = ['hourly', 'daily'];
                    if (!validTypes.includes(val)) val = 'hourly';
                }

                empParams.push(val);
            }
        });

        if (photo !== undefined) { empUpdates.push('`photo` = ?'); empParams.push(photo); }
        if (data.signature !== undefined) { 
            console.log('📝 Updating Signature. Length:', data.signature ? data.signature.length : 0);
            empUpdates.push('`signature` = ?'); 
            empParams.push(data.signature); 
        }
        if (data.is_uif_registered !== undefined) {
            const isUif = data.is_uif_registered === 'true' || data.is_uif_registered === true || data.is_uif_registered === 1 || data.is_uif_registered === '1';
            empUpdates.push('`is_uif_registered` = ?');
            empParams.push(isUif ? 1 : 0);
        }
        if (data.joined_date) { empUpdates.push('`joined_date` = ?'); empParams.push(data.joined_date.split('T')[0]); }

        if (empUpdates.length > 0) {
            const empQuery = `UPDATE employees SET ${empUpdates.join(', ')} WHERE id = ?`;
            empParams.push(id);
            console.log('📝 Executing SQL (Update Employee):', empQuery, 'Params:', empParams);
            await db.execute(empQuery, empParams);
        }

        // 3. Sync to Users Table (if relevant fields provided)
        const userUpdates = [];
        const userParams = [];

        if (data.email) { userUpdates.push('email = ?'); userParams.push(data.email); }
        if (data.name) { userUpdates.push('name = ?'); userParams.push(data.name); }
        if (photo) { userUpdates.push('photo = ?'); userParams.push(photo); }
        if (data.role) { userUpdates.push('role = ?'); userParams.push(isAdmin(data.role) ? data.role.toLowerCase() : 'employee'); }

        if (data.password && data.password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(data.password, 10);
            userUpdates.push('password = ?');
            userParams.push(hashedPassword);
        }

        if (userUpdates.length > 0) {
            const userQuery = `UPDATE users SET ${userUpdates.join(', ')} WHERE employee_id = ?`;
            userParams.push(id);
            console.log('📝 Executing SQL (Sync User):', userQuery, 'Params:', userParams);
            await db.execute(userQuery, userParams);
        }

        res.json({ message: 'Record updated successfully' });
    } catch (err) {
        console.error('❌ SQL Error (updateEmployee):', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Duplicate entry: Machine ID or Email already exists', error: err.message });
        }
        res.status(500).json({ message: 'Error updating record', error: err.message });
    }
};

// Delete employee
exports.deleteEmployee = async (req, res) => {
    const { id } = req.params;
    try {
        // Safety: If admin, verify ownership
        const [existing] = await db.execute('SELECT company_id FROM employees WHERE id = ?', [id]);
        if (existing.length > 0 && req.user.role !== 'MasterAdmin' && existing[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Cannot delete records from another company' });
        }

        const userSql = 'DELETE FROM users WHERE employee_id = ?';
        console.log('📝 Executing SQL:', userSql, 'Params:', [id]);
        await db.execute(userSql, [id]);

        const empSql = 'DELETE FROM employees WHERE id = ?';
        console.log('📝 Executing SQL:', empSql, 'Params:', [id]);
        const [result] = await db.execute(empSql, [id]);

        if (result.affectedRows === 0) return res.status(404).json({ message: 'Record not found' });
        res.json({ message: 'Record deleted successfully' });
    } catch (err) {
        console.error('❌ SQL Error (deleteEmployee):', err);
        res.status(500).json({ message: 'Error deleting record', error: err.message });
    }
};

