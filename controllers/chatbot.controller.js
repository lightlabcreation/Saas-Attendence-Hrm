exports.handleMessage = async (req, res) => {
    try {
        const { message, context } = req.body;
        
        if (!message || !context) {
            return res.status(400).json({ error: 'Message and context are required' });
        }

        const { userRole, currentPage } = context;
        const msgStr = message.toLowerCase();

        // Simulated AI Delay
        const delay = Math.floor(Math.random() * 1000) + 500;
        await new Promise(resolve => setTimeout(resolve, delay));

        let responseText = "I'm sorry, I couldn't understand that. Could you please rephrase?";

        // Role-based logic
        const normalizedRole = userRole ? userRole.toLowerCase() : 'guest';

        // 1. Landing Page / Guest Context
        if (normalizedRole === 'guest' || currentPage === '/') {
            if (msgStr.includes('hello') || msgStr.includes('hi')) {
                responseText = "Hello! 👋 I'm the Kiaan SaaS Assistant. Would you like to know about our features, pricing plans, or book a demo?";
            } else if (msgStr.includes('price') || msgStr.includes('plan')) {
                responseText = "We offer three flexible plans:\n\n1. **Free Trial** (7 Days) - Up to 10 Employees\n2. **Standard** ($49/mo) - Up to 50 Employees\n3. **Premium** ($99/mo) - Unlimited Employees.\n\nWould you like me to guide you to the billing page?";
            } else if (msgStr.includes('feature')) {
                responseText = "Kiaan HRM Pro is packed with features:\n- Real-time Biometric & Face Attendance\n- Automated Payroll\n- Rich Analytics\nWhat specific feature are you interested in?";
            } else if (msgStr.includes('demo') || msgStr.includes('trial')) {
                responseText = "You can start a 7-day free trial directly by clicking 'Get Started' on the top right. No credit card required!";
            } else if (msgStr.includes('support') || msgStr.includes('help')) {
                responseText = "For sales and support, please email support@kiaanhrm.com.";
            } else {
                responseText = "That's a great question about our platform! Could you provide a bit more detail, or would you like to explore our standard features?";
            }
        } 
        
        // 2. Employee Context
        else if (normalizedRole === 'employee') {
            if (msgStr.includes('admin') || msgStr.includes('revenue') || msgStr.includes('tenant')) {
                responseText = "🔒 I'm sorry, but you do not have permission to access administrative or platform data. I can help you with your attendance, leaves, or salary!";
            } else if (msgStr.includes('attendance') || msgStr.includes('mark') || msgStr.includes('check')) {
                if (currentPage.includes('face-attendance')) {
                    responseText = "You are currently on the Face Attendance page! Just click 'Start Face Scan', look straight into the camera, and smile briefly to log your attendance.";
                } else {
                    responseText = "You can view your attendance history on the 'My Attendance' page or mark your daily attendance using the Face Scanner module. Do you need help navigating there?";
                }
            } else if (msgStr.includes('salary') || msgStr.includes('payroll') || msgStr.includes('slip')) {
                responseText = "Your latest salary slips and payroll history are available in the 'My Salary' module. If you see any discrepancies, please contact your HR.";
            } else if (msgStr.includes('leave') || msgStr.includes('holiday')) {
                responseText = "You can request leaves through the 'My Leaves' section. I can show you the upcoming holiday calendar if you'd like.";
            } else {
                responseText = "I'm your Employee Assistant. I can help you check your attendance, understand your salary, or apply for leaves. How can I help today?";
            }
        }

        // 3. Admin / HR Context
        else if (normalizedRole === 'admin') {
            if (msgStr.includes('revenue') || msgStr.includes('tenant') || msgStr.includes('subscription')) {
                responseText = "🔒 I'm sorry, but that data is restricted to the SuperAdmin level. I can assist you with managing your company's employees and payroll.";
            } else if (msgStr.includes('employee') || msgStr.includes('add') || msgStr.includes('staff')) {
                responseText = "You can manage your staff in the 'Employees' module. You can add new employees, assign departments, and manage their base salaries there.";
            } else if (msgStr.includes('face') || msgStr.includes('register') || msgStr.includes('enroll')) {
                if (currentPage.includes('face-registration')) {
                    responseText = "You're on the right page! Select an employee from the dropdown and use the scanner to securely enroll their biometric face data.";
                } else {
                    responseText = "To register an employee's face for biometric attendance, please navigate to the 'Face Registration' page under the Admin menu.";
                }
            } else if (msgStr.includes('attendance') || msgStr.includes('report') || msgStr.includes('absent')) {
                responseText = "I can help you generate attendance reports. You can view daily stats, late arrivals, and absent employees from the 'Attendance' dashboard.";
            } else if (msgStr.includes('payroll') || msgStr.includes('generate')) {
                responseText = "Payroll can be generated monthly from the 'Payroll' module. It automatically calculates base salary, attendance deductions, and bonuses.";
            } else {
                responseText = "I'm your HR & Admin Assistant. I can help you with employee management, payroll generation, and attendance tracking. What do you need?";
            }
        }

        // 4. SuperAdmin Context
        else if (normalizedRole === 'superadmin') {
            if (msgStr.includes('tenant') || msgStr.includes('company') || msgStr.includes('companies')) {
                responseText = "You can manage all SaaS tenants from the 'Companies' dashboard. You have full control over their plans, statuses, and data.";
            } else if (msgStr.includes('revenue') || msgStr.includes('analytics') || msgStr.includes('stats')) {
                if (currentPage.includes('analytics')) {
                    responseText = "You're viewing the Analytics dashboard. Here you can see MRR (Monthly Recurring Revenue), active subscriptions, and growth trends.";
                } else {
                    responseText = "Our platform is currently generating strong revenue! You can view detailed financial reports and MRR charts in the 'Analytics' module.";
                }
            } else if (msgStr.includes('plan') || msgStr.includes('pricing') || msgStr.includes('billing')) {
                responseText = "You can create, modify, or delete SaaS pricing plans from the 'Billing & Plans' module. Changes will reflect instantly on the landing page.";
            } else if (msgStr.includes('request') || msgStr.includes('onboarding')) {
                responseText = "Pending company registrations are located in the 'Requests' tab. You can approve or reject new tenants from there.";
            } else {
                responseText = "I'm your SuperAdmin SaaS Assistant. I have full global awareness of tenant analytics, revenue, and platform settings. How can I assist you in managing the platform today?";
            }
        }

        res.json({ text: responseText });
    } catch (err) {
        console.error("Chatbot Error:", err);
        res.status(500).json({ error: "AI Engine encountered an error." });
    }
};
