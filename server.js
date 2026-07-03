// server.js - Complete with all endpoints
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

        if (!process.env.EXO_API_KEY) {
            return res.json({
                success: false,
                imported: 0,
                error: "Exosupplier API key not configured"
            });
        }

        await Service.deleteMany({});

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
    console.log(`📍 Health check: https://debby-booster-backend.onrender.com/health`);
});