// server.js - Complete Fixed Version with All Endpoints
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
require("dotenv").config();

const app = express();

// ==================== CORS ====================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ==================== MongoDB Connection ====================
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/debbybooster")
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.log("❌ MongoDB connection error:", err.message));

// ==================== Models ====================
const serviceSchema = new mongoose.Schema({
    id: { type: String, unique: true },
    name: String,
    priceUSD: Number,
    priceNGN: Number,
    category: String,
    subcategory: String,
    minQuantity: { type: Number, default: 100 },
    maxQuantity: Number,
    description: String,
    exoServiceId: String,
    userPriceNGN: { type: Number, default: null },
    profit: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'services' });
const Service = mongoose.model("Service", serviceSchema);

const orderSchema = new mongoose.Schema({
    serviceId: String,
    serviceName: String,
    amount: Number,
    userId: String,
    username: String,
    email: String,
    phone: String,
    quantity: Number,
    details: String,
    status: { type: String, default: "pending" },
    ref: String,
    providerId: String,
    createdAt: { type: Date, default: Date.now }
}, { collection: 'orders' });
const Order = mongoose.model("Order", orderSchema);

const depositSchema = new mongoose.Schema({
    userId: String,
    username: String,
    amount: Number,
    method: String,
    receipt: String,
    status: { type: String, default: "pending" },
    reference: String,
    createdAt: { type: Date, default: Date.now }
}, { collection: 'deposits' });
const Deposit = mongoose.model("Deposit", depositSchema);

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    email: { type: String, unique: true },
    phone: { type: String, unique: true, sparse: true },
    passwordHash: String,
    balance: { type: Number, default: 0 },
    referralBonus: { type: Number, default: 0 },
    referralCode: String,
    referredBy: String,
    country: String,
    role: { type: String, default: "user" },
    isActive: { type: Boolean, default: true },
    joined: { type: Date, default: Date.now }
}, { collection: 'users' });
const User = mongoose.model("User", userSchema);

// ==================== In-Memory Storage ====================
global.pendingPayments = {};

// ==================== Helper Functions ====================
const sendTelegram = async (msg) => {
    if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT) return;
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT,
            text: msg
        });
    } catch (err) {
        console.error("Telegram error:", err.message);
    }
};

// ==================== JWT Middleware ====================
const verifyAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "No token provided" });

    const token = authHeader.split(" ")[1];
    jwt.verify(token, process.env.JWT_SECRET || "debbybooster_secret_key", (err, decoded) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        req.admin = decoded;
        next();
    });
};

// ==================== CLEAR SERVICES ====================
app.post("/api/admin/clear-services", async (req, res) => {
    try {
        const result = await Service.deleteMany({});
        console.log(`🗑️ Cleared ${result.deletedCount} services`);
        res.json({
            success: true,
            message: `Cleared ${result.deletedCount} services`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error("Clear services error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== IMPORT SERVICES WITH NGN ====================
app.post("/api/admin/import-services-ngn", async (req, res) => {
    try {
        const { exchangeRate = 1500, profitMargin = 100 } = req.body;

        console.log("📥 Import request received with:", { exchangeRate, profitMargin });

        // Check if Exosupplier API key is configured
        if (!process.env.EXO_API_KEY) {
            console.error("❌ EXO_API_KEY not found in environment");
            return res.json({
                success: false,
                imported: 0,
                error: "Exosupplier API key not configured in .env file"
            });
        }

        // 1. Clear all existing services first
        const clearResult = await Service.deleteMany({});
        console.log(`🗑️ Cleared ${clearResult.deletedCount} old services`);

        // 2. Fetch services from Exosupplier
        console.log("📡 Fetching services from Exosupplier...");
        const response = await axios.post("https://exosupplier.com/api/v2", {
            key: process.env.EXO_API_KEY,
            action: "services"
        }, { timeout: 60000 });

        if (!response.data || !response.data.services) {
            console.error("❌ No services received from Exosupplier");
            return res.json({
                success: false,
                imported: 0,
                error: "No services received from Exosupplier"
            });
        }

        console.log(`📊 Received ${response.data.services.length} services from Exosupplier`);

        const exoServices = response.data.services;
        let importedCount = 0;
        const importedServices = [];
        const errors = [];

        // 3. Process each service
        for (const svc of exoServices) {
            try {
                // Calculate NGN price from USD
                const priceUSD = parseFloat(svc.price) || 0;
                const priceNGN = Math.ceil(priceUSD * exchangeRate) + profitMargin;

                // Get category and subcategory
                let category = svc.category || "Other";
                let subcategory = svc.subcategory || "General";

                // Map common categories
                const categoryMap = {
                    "instagram": "Instagram",
                    "twitter": "Twitter",
                    "youtube": "YouTube",
                    "facebook": "Facebook",
                    "tiktok": "TikTok",
                    "telegram": "Telegram",
                    "spotify": "Spotify",
                    "soundcloud": "SoundCloud",
                    "twitch": "Twitch"
                };

                const lowerCat = (svc.category || "").toLowerCase();
                for (const [key, value] of Object.entries(categoryMap)) {
                    if (lowerCat.includes(key)) {
                        category = value;
                        break;
                    }
                }

                // Create new service
                const newService = new Service({
                    id: `SVC_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                    name: svc.name || "Unknown Service",
                    priceUSD: priceUSD,
                    priceNGN: priceNGN,
                    category: category,
                    subcategory: subcategory,
                    minQuantity: Math.max(svc.min || 100, 100),
                    maxQuantity: svc.max || 5000,
                    description: svc.description || "",
                    exoServiceId: svc.id || svc.service || null,
                    userPriceNGN: null,
                    profit: profitMargin,
                    createdAt: new Date(),
                    updatedAt: new Date()
                });

                await newService.save();
                importedCount++;
                importedServices.push({
                    name: newService.name,
                    priceUSD: newService.priceUSD,
                    priceNGN: newService.priceNGN,
                    category: newService.category
                });

            } catch (err) {
                errors.push({ service: svc.name, error: err.message });
                console.error("Error importing service:", err.message);
            }
        }

        console.log(`✅ Imported ${importedCount} services with NGN prices`);

        res.json({
            success: true,
            imported: importedCount,
            exchangeRate: exchangeRate,
            profitMargin: profitMargin,
            services: importedServices,
            errors: errors,
            message: `Imported ${importedCount} services with ₦${exchangeRate}/USD rate + ₦${profitMargin} profit`
        });

    } catch (error) {
        console.error("Import error:", error);
        res.status(500).json({
            success: false,
            imported: 0,
            error: error.message
        });
    }
});

// ==================== UPDATE SERVICE PRICE ====================
app.put("/api/admin/service/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { userPriceNGN, profit } = req.body;

        const service = await Service.findOne({ id: id });
        if (!service) {
            return res.status(404).json({ success: false, error: "Service not found" });
        }

        if (userPriceNGN !== undefined) {
            service.userPriceNGN = userPriceNGN;
        }
        if (profit !== undefined) {
            service.profit = profit;
        }
        service.updatedAt = new Date();

        await service.save();
        res.json({ success: true, service });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== GET ALL SERVICES ====================
app.get("/api/admin/services", async (req, res) => {
    try {
        const services = await Service.find().sort({ category: 1, name: 1 });
        res.json({ success: true, services });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== BULK UPDATE PRICES ====================
app.post("/api/admin/services/bulk-update", async (req, res) => {
    try {
        const { exchangeRate, profitMargin } = req.body;
        const services = await Service.find();
        let updatedCount = 0;

        for (const service of services) {
            const newPriceNGN = Math.ceil(service.priceUSD * exchangeRate) + profitMargin;
            service.priceNGN = newPriceNGN;
            service.profit = profitMargin;
            service.updatedAt = new Date();
            await service.save();
            updatedCount++;
        }

        res.json({
            success: true,
            updated: updatedCount,
            exchangeRate,
            profitMargin
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== KORAPAY PAYMENT ====================
app.post("/api/korapay/pay", async (req, res) => {
    try {
        const { userId, amount, email } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid amount" });
        }

        const reference = `DB_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

        global.pendingPayments[reference] = {
            userId,
            amount: parseFloat(amount),
            email: email || "customer@example.com",
            status: "pending",
            timestamp: new Date().toISOString()
        };

        try {
            const deposit = new Deposit({
                userId,
                username: "pending",
                amount: parseFloat(amount),
                method: "korapay",
                reference: reference,
                status: "pending"
            });
            await deposit.save();
        } catch (err) {
            console.error("Failed to save deposit record:", err.message);
        }

        res.json({
            checkout_url: `https://checkout.korapay.com/pay/${reference}`,
            reference: reference,
            mock: true
        });

    } catch (error) {
        console.error("Korapay init error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post("/api/korapay/webhook", async (req, res) => {
    try {
        const event = req.body;
        console.log("Korapay webhook received:", event.event);

        if (event.event === "charge.success") {
            const reference = event.data.reference;
            const amount = event.data.amount;

            if (global.pendingPayments && global.pendingPayments[reference]) {
                global.pendingPayments[reference].status = "completed";
                global.pendingPayments[reference].completedAt = new Date().toISOString();
                console.log(`✅ Payment completed: ${reference}`);

                try {
                    const deposit = await Deposit.findOne({ reference: reference });
                    if (deposit) {
                        deposit.status = "approved";
                        await deposit.save();

                        const user = await User.findOne({ _id: deposit.userId });
                        if (user) {
                            user.balance = (user.balance || 0) + deposit.amount;
                            await user.save();
                            console.log(`✅ Credited ${deposit.amount} to user ${user.username}`);
                        }
                    }
                } catch (err) {
                    console.error("Failed to update deposit:", err.message);
                }

                await sendTelegram(`✅ New Korapay Payment!\nAmount: ₦${amount}\nReference: ${reference}`);
            }
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Webhook error:", error);
        res.sendStatus(500);
    }
});

app.get("/api/korapay/status/:reference", async (req, res) => {
    try {
        const { reference } = req.params;
        const payment = global.pendingPayments[reference];

        if (payment) {
            res.json({
                status: payment.status,
                amount: payment.amount,
                completedAt: payment.completedAt || null
            });
        } else {
            res.json({ status: "not_found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ORDER ENDPOINTS ====================
app.post("/api/orders", async (req, res) => {
    try {
        const { userId, serviceId, quantity, details, username, email } = req.body;

        if (!userId || !serviceId || !quantity || !details) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        if (quantity < 100) {
            return res.status(400).json({ error: "Minimum order quantity is 100" });
        }

        let exoResult = null;
        let orderStatus = "pending";
        let apiProcessed = false;

        if (process.env.EXO_API_KEY && process.env.EXO_API_KEY !== "your_exosupplier_api_key_here") {
            try {
                exoResult = await axios.post("https://exosupplier.com/api/v2", {
                    key: process.env.EXO_API_KEY,
                    action: "add",
                    service: serviceId,
                    link: details,
                    quantity: quantity
                }, { timeout: 30000 });

                if (exoResult.data && exoResult.data.order) {
                    orderStatus = "processing";
                    apiProcessed = true;
                }
            } catch (exoError) {
                console.error("Exosupplier error:", exoError.message);
            }
        }

        try {
            const user = await User.findById(userId);
            if (user) {
                const service = await Service.findOne({ id: serviceId });
                if (service) {
                    const pricePerUnit = service.userPriceNGN || service.priceNGN;
                    const totalCost = pricePerUnit * quantity;
                    if (user.balance < totalCost) {
                        return res.status(400).json({ error: "Insufficient balance", required: totalCost });
                    }
                    user.balance -= totalCost;
                    await user.save();
                }
            }
        } catch (err) {
            console.error("Failed to deduct balance:", err.message);
        }

        try {
            const order = new Order({
                serviceId,
                serviceName: "Service " + serviceId,
                amount: 0,
                userId,
                username: username || "unknown",
                email: email || "",
                quantity,
                details,
                status: orderStatus,
                ref: exoResult?.data?.order || `ORD_${Date.now()}`,
                providerId: exoResult?.data?.order || null
            });
            await order.save();
        } catch (err) {
            console.error("Failed to save order:", err.message);
        }

        res.json({
            id: exoResult?.data?.order || "ORD_" + Date.now(),
            status: orderStatus,
            apiProcessed: apiProcessed,
            message: apiProcessed ? "Order sent to Exosupplier" : "Order saved locally"
        });

    } catch (error) {
        console.error("Order error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get("/api/orders/:id", async (req, res) => {
    try {
        const order = await Order.findOne({ ref: req.params.id });
        if (order) {
            res.json({ status: order.status });
        } else {
            res.json({ status: "pending", message: "Order not found in database" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== EXOSUPPLIER API ====================
app.post("/api/test-connection", async (req, res) => {
    try {
        const { endpoint, key } = req.body;

        if (!endpoint || !key) {
            return res.json({ success: false, error: "Missing endpoint or API key" });
        }

        const response = await axios.post(endpoint, {
            key: key,
            action: "services"
        }, { timeout: 30000 });

        if (response.data && (response.data.services || response.data.error === undefined)) {
            res.json({ success: true, message: "Connection successful" });
        } else {
            res.json({ success: false, error: response.data.error || "Invalid response" });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== ADMIN ENDPOINTS ====================
app.post("/api/admin/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASS) {
            const token = jwt.sign({ email, role: "admin" }, process.env.JWT_SECRET || "debbybooster_secret_key", { expiresIn: "7d" });
            return res.json({ success: true, token });
        }
        res.json({ success: false, message: "Invalid credentials" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/admin/services", verifyAdmin, async (req, res) => {
    try {
        const { name, price, category, minQuantity, maxQuantity, description } = req.body;
        const service = new Service({
            name,
            price,
            category,
            minQuantity: Math.max(minQuantity || 100, 100),
            maxQuantity,
            description
        });
        await service.save();
        res.json({ message: "Service added successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/orders", verifyAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/users", verifyAdmin, async (req, res) => {
    try {
        const users = await User.find().select("-passwordHash");
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/admin/deposits", verifyAdmin, async (req, res) => {
    try {
        const deposits = await Deposit.find().sort({ createdAt: -1 });
        res.json(deposits);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== USER AUTH ====================
app.post("/api/auth/register", async (req, res) => {
    try {
        const { username, email, phone, password, country, referralCode } = req.body;

        const existingUser = await User.findOne({
            $or: [{ username }, { email }, { phone }]
        });
        if (existingUser) {
            return res.status(400).json({ error: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newReferralCode = `REF_${username}_${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

        const user = new User({
            username,
            email,
            phone,
            passwordHash: hashedPassword,
            country,
            referralCode: newReferralCode,
            referredBy: referralCode || null
        });

        await user.save();
        res.json({ success: true, message: "User registered successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({
            $or: [
                { username: username },
                { email: username },
                { phone: username }
            ]
        });

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const isValid = await bcrypt.compare(password, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { id: user._id, username: user.username, role: user.role },
            process.env.JWT_SECRET || "debbybooster_secret_key",
            { expiresIn: "7d" }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                phone: user.phone,
                balance: user.balance,
                role: user.role,
                referralCode: user.referralCode
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== ROOT ROUTES ====================
app.get("/", (req, res) => {
    res.json({ 
        status: "Debby Booster API is running", 
        version: "2.0.0",
        timestamp: new Date().toISOString()
    });
});

app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ==================== AUTO-CHECK STATUS ====================
async function checkStatus() {
    try {
        const orders = await Order.find({ status: "processing" });
        for (const o of orders) {
            if (!o.providerId) continue;
            try {
                const res = await axios.post("https://exosupplier.com/api/v2", {
                    key: process.env.EXO_API_KEY,
                    action: "status",
                    order: o.providerId
                });
                if (res.data.status === "Completed") {
                    o.status = "completed";
                    await o.save();
                }
            } catch (err) {
                console.error("Status check error:", err.message);
            }
        }
    } catch (err) {
        console.error("Status check error:", err);
    }
}
setInterval(checkStatus, 600000);

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`✅ Debby Booster backend running on port ${PORT}`);
    console.log(`📍 Health check: https://debby-booster-backend.onrender.com/health`);
    console.log(`📍 API URL: https://debby-booster-backend.onrender.com`);
});
// ==================== CLEAR SERVICES ====================
app.post("/api/admin/clear-services", async (req, res) => {
    try {
        const result = await Service.deleteMany({});
        res.json({
            success: true,
            message: `Cleared ${result.deletedCount} services`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== IMPORT SERVICES WITH NGN ====================
app.post("/api/admin/import-services-ngn", async (req, res) => {
    try {
        const { exchangeRate = 1500, profitMargin = 100 } = req.body;
        
        // Check if Exosupplier API key exists
        if (!process.env.EXO_API_KEY) {
            return res.json({
                success: false,
                imported: 0,
                error: "Exosupplier API key not configured"
            });
        }
        
        // Clear existing services
        await Service.deleteMany({});
        
        // Fetch from Exosupplier
        const response = await axios.post("https://exosupplier.com/api/v2", {
            key: process.env.EXO_API_KEY,
            action: "services"
        }, { timeout: 60000 });
        
        if (!response.data || !response.data.services) {
            return res.json({
                success: false,
                imported: 0,
                error: "No services received from Exosupplier"
            });
        }
        
        const exoServices = response.data.services;
        let importedCount = 0;
        const importedServices = [];
        
        for (const svc of exoServices) {
            try {
                const priceUSD = parseFloat(svc.price) || 0;
                const priceNGN = Math.ceil(priceUSD * exchangeRate) + profitMargin;
                
                const newService = new Service({
                    id: `SVC_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
                    name: svc.name || "Unknown Service",
                    priceUSD: priceUSD,
                    priceNGN: priceNGN,
                    category: svc.category || "Other",
                    subcategory: svc.subcategory || "General",
                    minQuantity: Math.max(svc.min || 100, 100),
                    maxQuantity: svc.max || 5000,
                    description: svc.description || "",
                    exoServiceId: svc.id || svc.service || null,
                    userPriceNGN: null,
                    profit: profitMargin
                });
                
                await newService.save();
                importedCount++;
                importedServices.push({
                    name: newService.name,
                    priceUSD: newService.priceUSD,
                    priceNGN: newService.priceNGN,
                    category: newService.category
                });
            } catch (err) {
                console.error("Error importing service:", err.message);
            }
        }
        
        res.json({
            success: true,
            imported: importedCount,
            exchangeRate: exchangeRate,
            profitMargin: profitMargin,
            services: importedServices,
            message: `Imported ${importedCount} services`
        });
        
    } catch (error) {
        console.error("Import error:", error);
        res.status(500).json({
            success: false,
            imported: 0,
            error: error.message
        });
    }
});

// ==================== GET ALL SERVICES ====================
app.get("/api/admin/services", async (req, res) => {
    try {
        const services = await Service.find().sort({ category: 1, name: 1 });
        res.json({ success: true, services });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
    res.json({ status: "healthy", timestamp: new Date().toISOString() });
});