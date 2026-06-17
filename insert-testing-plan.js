const db = require('./config/db');

async function insertPlan() {
  console.log("Inserting ₹1 testing plan...");
  try {
    const name = "Testing Plan";
    const price = "$0.0125"; // 0.0125 * 80 = 1 INR
    const duration = "/ 1 day";
    const description = "1 Rupee Live Testing Plan. Remove this plan after testing.";
    const features = JSON.stringify(["1 Rupee Test", "Full Premium Access", "Live Payment Verification"]);
    const buttonText = "Test Pay";
    const isPopular = 1;

    // Check if the plan already exists
    const [existing] = await db.execute('SELECT id FROM plans WHERE name = ? LIMIT 1', [name]);
    if (existing.length > 0) {
      console.log("Plan already exists! Updating its price to $0.0125...");
      await db.execute(
        'UPDATE plans SET price = ?, duration = ?, description = ?, features = ?, buttonText = ? WHERE id = ?',
        [price, duration, description, features, buttonText, existing[0].id]
      );
      console.log("✓ Updated plan successfully.");
    } else {
      await db.execute(
        'INSERT INTO plans (name, price, duration, description, features, buttonText, isPopular) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, price, duration, description, features, buttonText, isPopular]
      );
      console.log("✓ Inserted plan successfully.");
    }

    console.log("Current plans in database:");
    const [rows] = await db.execute('SELECT * FROM plans');
    console.log(rows);
    process.exit(0);
  } catch (err) {
    console.error("Error inserting plan:", err);
    process.exit(1);
  }
}

insertPlan();
