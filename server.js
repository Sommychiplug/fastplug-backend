const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
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
// ==================== IMPORT SERVICES WITH NGN ====================
app.post("/api/admin/import-services-ngn", async (req, res) => {
    try {
        const { exchangeRate = 1500, profitMargin = 100 } = req.body;

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

        // The response is an array directly, not { services: [...] }
        const exoServices = response.data;
        
        // Check if it's an array
        if (!Array.isArray(exoServices) || exoServices.length === 0) {
            return res.json({
                success: false,
                imported: 0,
                error: "No services received from Exosupplier"
            });
        }

        let importedCount = 0;
        const importedServices = [];

        for (const svc of exoServices) {
            try {
                const priceUSD = parseFloat(svc.rate) || 0;
                const priceNGN = Math.ceil(priceUSD * exchangeRate) + profitMargin;

                // Get category from the response
                let category = svc.category || "Other";
                let subcategory = svc.type || svc.subcategory || "General";

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
                    exoServiceId: svc.service || svc.id || null,
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

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`✅ Debby Booster backend running on port ${PORT}`);
    console.log(`📍 Health check: https://fastplug-api.onrender.com/health`);
});